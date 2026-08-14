import type { InboundMessage } from "@omp-bundler/contracts/inbound";

/**
 * A single attachment carried on a Pumble `NEW_MESSAGE` event.
 *
 * Only the fields the bridge consumes are kept. The download path turns these
 * into workspace-relative paths that cross the adapter seam; this module never
 * handles inline bytes.
 */
export interface PumbleMessageFile {
  id: string;
  owner?: string;
  name: string;
  mimeType?: string;
  path?: string;
  publicPath?: string;
  size?: number;
}

/**
 * A quoted message, as carried on the message that quotes it.
 *
 * Pumble sends the quoted text inline rather than only a reference, so no
 * extra fetch is needed to show the agent what was quoted.
 */
export interface PumbleQuote {
  text: string;
  authorId?: string;
  messageId?: string;
}

/**
 * Parsed `NEW_MESSAGE` event before adapter-side touches (channel resolution,
 * display-name lookup, attachment download) produce the inputs normalization
 * needs. Carries only fields read from the webhook payload.
 */
export interface PumbleMessageEvent {
  workspaceId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  text: string;
  files: PumbleMessageFile[];
  mentionedUserIds: string[];
  /** Whether Pumble marked the message ephemeral. Ephemeral messages are dropped. */
  ephemeral: boolean;
  threadRootId?: string;
  /**
   * Resolved channel type from the payload when Pumble embeds it.
   * {@link normalizePumbleMessage} takes the authoritative value. Uppercased.
   */
  channelType?: string;
  /**
   * Author kind from the payload when Pumble embeds it, uppercased. A non-human
   * value (see {@link NON_HUMAN_AUTHOR_TYPES}) marks the author as a bot or
   * integration, which is dropped during normalization.
   */
  authorType?: string;
  /**
   * The message this one quotes, when the author quoted something. Carried
   * through so the agent can read what was quoted: a question about a quoted
   * message is unanswerable without it.
   */
  quote?: PumbleQuote;
}

/** Workspace-relative attachment ref that crosses the adapter seam. */
type Attachment = InboundMessage["attachments"][number];

/** Party that produced the message. */
type Speaker = InboundMessage["speaker"];

/**
 * Inputs {@link normalizePumbleMessage} cannot read from the payload alone.
 * Each is produced by an adapter-side touch:
 *   - `botId`: the configured bot user id for the workspace (OAuth install).
 *   - `channelType`: resolved channel type, uppercased, authoritative.
 *   - `authorDisplayName`: display name resolved for `event.authorId`.
 *   - `attachments`: downloaded attachment refs, workspace-relative paths.
 */
export interface NormalizeContext {
  botId?: string;
  channelType: string;
  authorDisplayName: string;
  attachments: Attachment[];
  /**
   * Display name resolved for the quoted message's author, when the message
   * quotes one. Falls back to the raw author id.
   */
  quoteAuthorDisplayName?: string;
  /**
   * Whether the agent has already taken a turn in this thread. A thread it
   * participates in is treated like a direct conversation; one it has only
   * observed is not.
   */
  threadParticipant?: boolean;
}

/** Channel types treated as direct conversations with the agent. */
const DIRECT_CHANNEL_TYPES: Record<string, true> = {
  DIRECT: true,
  SELF: true,
};

/** Author kinds that never become agent turns (bots and integrations). */
const NON_HUMAN_AUTHOR_TYPES: Record<string, true> = {
  BOT: true,
  INTEGRATION: true,
  APP: true,
};

/**
 * Parse a Pumble `NEW_MESSAGE` webhook payload into a typed internal event.
 *
 * Reads the short-key body Pumble emits (`wId`, `cId`, `mId`, `aId`, `tx`,
 * `f`, `md`, `trId`, `eph`) with long-key fallbacks, mirroring the reference
 * bridge. Returns `null` for malformed payloads missing workspace, channel,
 * message, author, or any message content (text or files).
 *
 * This is pure extraction: it does not normalize text, drop authors, or decide
 * activation. Those belong to {@link normalizePumbleMessage}, once channel
 * resolution, display-name lookup, and attachment download have run.
 */
export function parseNewMessage(
  payload: Record<string, unknown>,
): PumbleMessageEvent | null {
  const body = bodyMapping(payload.body);
  const workspaceId = stringValue(payload.workspaceId) || stringValue(body.wId);
  const channelId = stringValue(body.cId) || stringValue(payload.channelId);
  const messageId = stringValue(body.mId) || stringValue(payload.messageId);
  const authorId = stringValue(body.aId) || stringValue(payload.authorId);
  const text = stringValue(body.tx) || stringValue(payload.text);
  const files = parseMessageFiles(body.f);
  // Only identity makes a message unroutable. Empty content does not: Pumble
  // omits `f` from the NEW_MESSAGE webhook for a file posted with no caption,
  // so rejecting here dropped image-only messages entirely -- no webhook
  // trace, no reply, nothing for the sender to see. The caller refetches the
  // message from the API and decides then.
  if (!workspaceId || !channelId || !messageId || !authorId) {
    return null;
  }
  const channelTypeRaw = stringValue(
    body.channelType || body.chType || body.cType || payload.channelType,
  ).toUpperCase();
  const authorTypeRaw = stringValue(
    body.aType || body.authorType || payload.authorType,
  ).toUpperCase();
  return {
    workspaceId,
    channelId,
    messageId,
    authorId,
    text,
    files,
    mentionedUserIds: parseStringArray(body.md),
    threadRootId: optionalString(body.trId) ?? undefined,
    ephemeral: Boolean(body.eph ?? payload.ephemeral),
    channelType: channelTypeRaw || undefined,
    authorType: authorTypeRaw || undefined,
    quote: parseQuote(body.qu ?? body.quote ?? payload.quote),
  };
}

/**
 * Normalize a parsed Pumble message into an {@link InboundMessage}, or `null`
 * when the message must not reach the agent.
 *
 * Drops, in order:
 *   1. ephemeral messages;
 *   2. messages authored by the configured bot itself (echo suppression);
 *   3. messages authored by other bots or integrations;
 *   4. messages that resolve to empty text and empty attachments (unsupported).
 *
 * The conversation key is `pumble:<workspaceId>:<channelId>`: stable across a
 * channel, independent of author and thread. Activation (`addressed`) is true
 * for direct and self channels, or when the configured bot is in the message's
 * structured mention list; otherwise it is ambient (`false`). Mention
 * detection uses the parsed `mentionedUserIds`, never text substring matching.
 *
 * The exact configured-bot mention token `<@botId>` is stripped from the text so
 * the agent sees the user's message; the configured bot's display name is not
 * stripped (unreliable substring matching). Outputs exactly the six contract
 * fields with no Pumble-native keys. Author id and resolved display name are
 * preserved as the {@link Speaker}.
 */
export function normalizePumbleMessage(
  event: PumbleMessageEvent,
  ctx: NormalizeContext,
): InboundMessage | null {
  if (event.ephemeral) {
    return null;
  }
  if (ctx.botId && ctx.botId === event.authorId) {
    return null;
  }
  if (event.authorType && NON_HUMAN_AUTHOR_TYPES[event.authorType]) {
    return null;
  }

  const channelType = ctx.channelType.toUpperCase();
  const direct = DIRECT_CHANNEL_TYPES[channelType] === true;
  const mentioned =
    Boolean(ctx.botId) && event.mentionedUserIds.includes(ctx.botId!);

  const body = stripBotMentionToken(event.text, ctx.botId);
  if (!body && ctx.attachments.length === 0) {
    return null;
  }
  // Prepend the quoted message so a question about it is answerable. Without
  // this the agent sees only "what did I quote?" and has to guess.
  const quoted = event.quote?.text.trim();
  const quotedBy = ctx.quoteAuthorDisplayName?.trim() || event.quote?.authorId;
  const text = quoted
    ? `[quoting ${quotedBy ?? "someone"}: ${quoted}]${body ? `\n${body}` : ""}`
    : body;

  const displayName = ctx.authorDisplayName.trim();
  const speaker: Speaker = displayName
    ? { id: event.authorId, displayName }
    : { id: event.authorId, displayName: event.authorId };

  // A thread is its own conversation, forked from the channel it started in.
  // Without the thread component every thread in a channel shares one session
  // and parallel threads interleave into a single context.
  const channelKey = `pumble:${event.workspaceId}:${event.channelId}`;
  const threadRootId = event.threadRootId;
  return {
    messageId: event.messageId,
    conversationKey: threadRootId
      ? `${channelKey}:${threadRootId}`
      : channelKey,
    ...(threadRootId ? { parentConversationKey: channelKey } : {}),
    speaker,
    text,
    attachments: ctx.attachments,
    // A thread the agent is already part of behaves like a DM: every message
    // in it is addressed, because entering that thread is the act of address
    // and nobody re-tags the bot on each follow-up. A thread it has never
    // spoken in stays ambient, so two people threading among themselves do
    // not pull it in.
    addressed: direct || mentioned || ctx.threadParticipant === true,
  };
}

/**
 * Decode the webhook `body` field into a record. Pumble sends it either as an
 * embedded object or as a JSON string.
 */
function bodyMapping(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Strip the exact configured-bot mention token `<@botId>` from the text. This
 * matches the structured mention form only, never a name substring, so it does
 * not affect other `@` mentions or ids that merely contain the bot id.
 */
function stripBotMentionToken(text: string, botId?: string): string {
  if (!botId) {
    return text.trim();
  }
  return text
    .replace(new RegExp(`<@${escapeRegExp(botId)}>`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read a quoted message from a payload.
 *
 * Pumble's REST API names this `quote` with a plain `text`, while webhook
 * payloads abbreviate keys. Both spellings are accepted rather than assuming
 * one, since a missed quote is silent: the agent answers a question about a
 * message it cannot see. Returns undefined when nothing usable is present.
 */
function parseQuote(value: unknown): PumbleQuote | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const text = stringValue(record.tx) || stringValue(record.text);
  if (!text) {
    return undefined;
  }
  return {
    text,
    authorId:
      optionalString(record.aId) ?? optionalString(record.authorId) ?? undefined,
    messageId:
      optionalString(record.mId) ?? optionalString(record.messageId) ?? undefined,
  };
}

/**
 * Read a message's file list. Exported because the webhook omits files, so the
 * adapter re-reads them from the API using the same shape.
 */
export function parseMessageFiles(value: unknown): PumbleMessageFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const file = item as Record<string, unknown>;
    const id = stringValue(file.id);
    const path = stringValue(file.path);
    const publicPath = stringValue(file.publicPath);
    if (!id && !path && !publicPath) {
      return [];
    }
    const name = stringValue(file.name) || id || "pumble-file";
    return [
      {
        id,
        owner: optionalString(file.owner) ?? undefined,
        name,
        mimeType: optionalString(file.mimeType) ?? undefined,
        path: path || undefined,
        publicPath: publicPath || undefined,
        size:
          typeof file.size === "number" && Number.isFinite(file.size)
            ? file.size
            : undefined,
      },
    ];
  });
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
