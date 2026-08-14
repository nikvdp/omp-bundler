import http from "node:http";
import path from "node:path";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import crypto from "node:crypto";
import { joinPublicUrl, loadBridgeConfig } from "./config.js";
import { buildManifest, pumbleAuthorizationScopes } from "./manifest.js";
import { PumbleApi } from "./pumble-api.js";
import { verifyPumbleSignature } from "./security.js";
import { TokenStore } from "./token-store.js";
import { TargetStore, type Target } from "./target-store.js";
import { SettingsStore } from "./settings.js";
import { PumbleAttachmentSender } from "./attachment-sender.js";
import { DeliveryStore } from "./delivery-store.js";
import {
  parseNewMessage,
  normalizePumbleMessage,
  parseMessageFiles,
  type NormalizeContext,
} from "./pumble-event.js";
import {
  savePumbleFiles,
  type PumbleMessageFilesEvent,
} from "./pumble-files.js";
import {
  PumbleRenderer,
  type ConversationResolver,
} from "./pumble-renderer.js";
import type { OutboundEvent } from "@omp-bundler/contracts/outbound";
import {
  OUTBOUND_EVENT_MEDIA_TYPE,
  OUTBOUND_EVENT_SIGNATURE_HEADER,
  ADAPTER_API_VERSION,
} from "@omp-bundler/contracts/outbound";
import { INBOUND_MESSAGE_MEDIA_TYPE } from "@omp-bundler/contracts/inbound";

/** Header carrying the presented shared secret on an inbound adapter request. */
const INBOUND_SECRET_HEADER = "X-OMP-Bundler-Adapter-Secret";
const OAUTH_STATE_COOKIE = "pumble_oauth_nonce";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_OAUTH_STATES = 1_000;
const oauthStates = new Map<string, { nonce: string; expiresAt: number }>();
const config = loadBridgeConfig();
await mkdir(config.pumbleDataDir, { recursive: true });

const pumble = new PumbleApi(config);
const tokens = new TokenStore(
  path.join(config.pumbleDataDir, "workspaces.json"),
);
const targetStore = new TargetStore(
  path.join(config.pumbleDataDir, "targets.json"),
);
const deliveryStore = new DeliveryStore(
  path.join(config.pumbleDataDir, "delivered-events.json"),
);
const settings = new SettingsStore({
  file: config.settingsFile,
  logger: console,
});
settings.seed();

const attachmentSender = new PumbleAttachmentSender(config, pumble);

const resolver: ConversationResolver = async (
  conversationKey,
  correlationId,
) => {
  const target = await targetStore.resolve(conversationKey, correlationId);
  if (!target) return null;
  const workspaceTokens = await tokens.getWorkspace(target.workspaceId);
  if (!workspaceTokens?.botToken) {
    throw new Error(`no bot token for workspace ${target.workspaceId}`);
  }
  return {
    appKey: config.appKey,
    botToken: workspaceTokens.botToken,
    channelId: target.channelId,
    triggerMessageId: target.triggerMessageId,
    threadRootId: target.threadRootId,
    direct: target.direct,
  };
};

const renderer = new PumbleRenderer({
  pumble,
  resolver,
  logger: console,
  attachmentSender,
  checkpointStore: deliveryStore,
  settings,
});

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble adapter request failed:", message);
    sendText(res, 500, "internal error");
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `>>> Pumble adapter listening on http://${config.host}:${config.port}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(">>> Pumble adapter shutdown failed:", error.message);
        process.exitCode = 1;
      }
    });
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", service: "pumble-adapter" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pumble/manifest.json") {
    sendJson(res, 200, buildManifest(config));
    return;
  }

  if (req.method === "GET" && url.pathname === "/pumble/oauth/start") {
    handleOAuthStart(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/pumble/oauth/callback") {
    await handleOAuthCallback(req, url, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/pumble/events") {
    await handlePumbleEvents(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/core/events") {
    await handleCoreEvents(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/download") {
    await handleDownload(url, res);
    return;
  }

  sendText(res, 404, "not found");
}

// ---------------------------------------------------------------------------
// OAuth authorization
// ---------------------------------------------------------------------------

function handleOAuthStart(res: http.ServerResponse) {
  pruneOAuthStates();
  if (oauthStates.size >= MAX_OAUTH_STATES) {
    sendText(res, 503, "Too many pending OAuth requests");
    return;
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  oauthStates.set(state, { nonce, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });

  const callbackUrl = joinPublicUrl(config, "/pumble/oauth/callback");
  const authorizationUrl = pumble.authorizationUrl(
    callbackUrl,
    state,
    pumbleAuthorizationScopes,
  );

  res.writeHead(302, {
    location: authorizationUrl,
    "cache-control": "no-store",
    "set-cookie": `${OAUTH_STATE_COOKIE}=${nonce}; Max-Age=${
      OAUTH_STATE_TTL_MS / 1000
    }; Path=/pumble/oauth/callback; HttpOnly; Secure; SameSite=Lax`,
  });
  res.end();
}

async function handleOAuthCallback(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
) {
  const state = url.searchParams.get("state")?.trim() || "";
  const nonce = cookieValue(req.headers.cookie, OAUTH_STATE_COOKIE);
  if (!consumeOAuthState(state, nonce)) {
    sendText(res, 400, "Invalid or expired OAuth state");
    return;
  }

  res.setHeader(
    "set-cookie",
    `${OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/pumble/oauth/callback; HttpOnly; Secure; SameSite=Lax`,
  );
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    sendText(res, 400, "Missing code query parameter");
    return;
  }
  if (!config.appId || !config.clientSecret) {
    sendText(res, 400, "Missing Pumble app credentials");
    return;
  }

  try {
    const payload = await pumble.exchangeCode(code);
    await tokens.saveOAuthPayload(payload);
    sendText(
      res,
      200,
      "Pumble authorization completed. You can close this window.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble OAuth exchange failed:", message);
    sendText(res, 401, "Could not authorize Pumble app.");
  }
}

// ---------------------------------------------------------------------------
// Pumble webhook: NEW_MESSAGE ingestion
// ---------------------------------------------------------------------------

async function handlePumbleEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const rawBody = await readBody(req, config.pumbleEventMaxBytes);
  if (!rawBody) {
    sendText(res, 413, "Request body exceeds maximum size");
    return;
  }

  if (
    !verifyPumbleSignature(
      req.headers,
      rawBody,
      config.signingSecret,
      config.signatureToleranceSeconds,
    )
  ) {
    // Log rejections: a silently dropped webhook is indistinguishable from one
    // Pumble never sent, which makes the difference impossible to diagnose from
    // the outside.
    console.warn(
      ">>> Pumble event rejected: invalid signature",
      `timestamp=${headerValue(req.headers["x-pumble-request-timestamp"])}`,
      `bytes=${rawBody.length}`,
    );
    sendText(res, 401, "Invalid signature");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  const eventType =
    typeof payload.eventType === "string" ? payload.eventType : "";
  const workspaceId =
    typeof payload.workspaceId === "string" ? payload.workspaceId : "";

  if (
    workspaceId &&
    (eventType === "APP_UNAUTHORIZED" || eventType === "APP_UNINSTALLED")
  ) {
    await tokens.deleteWorkspace(workspaceId);
    sendText(res, 200, "ok");
    return;
  }

  if (eventType !== "NEW_MESSAGE") {
    console.log(`>>> Pumble event ignored: type=${eventType || "(none)"}`);
    sendText(res, 200, "ok");
    return;
  }

  console.log(`>>> Pumble NEW_MESSAGE accepted workspace=${workspaceId}`);
  const result = await processNewMessage(payload);
  if (!result.ok) {
    // Missing tokens, context, or download failures are explicit, retryable.
    // 5xx so Pumble retries; safe failures are never silent.
    console.warn(">>> Pumble NEW_MESSAGE failed:", result.error || "unknown");
    sendText(res, 500, result.error || "processing failed");
    return;
  }

  sendText(res, 200, "ok");
}

interface NewMessageResult {
  ok: boolean;
  error?: string;
}

/**
 * Whether the message that opened a thread addressed the agent.
 *
 * When someone starts a thread by mentioning the bot, or starts one in a DM,
 * the thread is a conversation with the agent and every later message in it
 * counts as addressed. Cached because it is fixed for the life of the thread
 * and would otherwise cost an API call on every reply.
 *
 * A failed lookup returns false: treating an unknown thread as not-addressed
 * only means the bot needs an explicit mention there.
 */
const threadRootAddressed = new Map<string, boolean>();
/** Bounds the cache; oldest entries are evicted, and a miss simply re-fetches. */
const THREAD_ROOT_CACHE_LIMIT = 500;

async function isThreadRootAddressedToAgent(
  channelId: string,
  threadRootId: string,
  workspaceTokens: { botToken?: string; botId?: string },
): Promise<boolean> {
  const { botToken, botId } = workspaceTokens;
  // Without a token or bot id there is nothing to compare a mention against.
  if (!botToken || !botId) return false;
  const cacheKey = `${channelId}:${threadRootId}`;
  const cached = threadRootAddressed.get(cacheKey);
  if (cached !== undefined) return cached;

  let addressed = false;
  try {
    const root = await pumble.fetchMessage(
      config.appKey,
      botToken,
      channelId,
      threadRootId,
    );
    const record = (root.message ?? root) as Record<string, unknown>;
    const mentioned = Array.isArray(record.mentionedUserIds)
      ? record.mentionedUserIds.includes(botId)
      : false;
    // Fall back to the raw mention token: the REST shape does not always
    // expose a parsed mention list.
    addressed = mentioned || stringValue(record.text).includes(`<@${botId}>`);
  } catch (error) {
    console.warn(
      ">>> Pumble thread root lookup failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (threadRootAddressed.size >= THREAD_ROOT_CACHE_LIMIT) {
    const oldest = threadRootAddressed.keys().next().value;
    if (oldest !== undefined) threadRootAddressed.delete(oldest);
  }
  threadRootAddressed.set(cacheKey, addressed);
  return addressed;
}

async function processNewMessage(
  payload: Record<string, unknown>,
): Promise<NewMessageResult> {
  const event = parseNewMessage(payload);
  if (!event) {
    // Malformed payload: not retryable, but we ack so Pumble does not retry.
    return { ok: true };
  }

  // Load workspace tokens; missing tokens is explicit and retryable.
  const workspaceTokens = await tokens.getWorkspace(event.workspaceId);
  if (!workspaceTokens) {
    return {
      ok: false,
      error: `no workspace tokens for workspace ${event.workspaceId}`,
    };
  }
  if (!workspaceTokens.botToken || !workspaceTokens.accessToken) {
    return {
      ok: false,
      error: `workspace ${event.workspaceId} is missing bot or access token`,
    };
  }
  if (!config.appKey) {
    return {
      ok: false,
      error: "PUMBLE_APP_KEY is not configured",
    };
  }

  // Resolve channel type from the Pumble API (authoritative).
  let channelType = event.channelType || "";
  if (!channelType) {
    try {
      const channelResponse = await pumble.getChannel(
        config.appKey,
        workspaceTokens.botToken,
        event.channelId,
      );
      // Pumble nests the channel under a `channel` key; the type is not at the
      // top level. Read both so either shape resolves.
      const nested = channelResponse.channel;
      const channelBody =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : channelResponse;
      channelType =
        stringValue(channelBody.channelType) ||
        stringValue(channelBody.type) ||
        stringValue(channelResponse.type) ||
        "";
    } catch (error) {
      return {
        ok: false,
        error: `channel resolution failed for ${event.channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (!channelType) {
    return {
      ok: false,
      error: `could not determine channel type for ${event.channelId}`,
    };
  }

  // Resolve the author's display name so the agent can say who spoke. This is
  // cosmetic: normalizePumbleMessage falls back to the author id when the name
  // is blank, so a lookup failure must not drop the message. The bot also only
  // has this permission when the workspace granted user:read at install time,
  // which older installs did not.
  let authorDisplayName = "";
  try {
    const userResponse = await pumble.getUser(
      config.appKey,
      workspaceTokens.botToken,
      event.authorId,
    );
    authorDisplayName =
      stringValue(userResponse.name) ||
      stringValue(userResponse.displayName) ||
      stringValue(userResponse.username) ||
      "";
  } catch (error) {
    console.warn(
      `>>> Pumble user lookup failed for ${event.authorId}; using id as display name:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  // The NEW_MESSAGE webhook carries neither the quoted message nor uploaded
  // files, so read them back from the API. Without this the agent is asked
  // about a quote or an image it cannot see and answers from a guess.
  // Non-fatal: a failed fetch costs that context, not the message.
  if (!event.quote || event.files.length === 0) {
    try {
      const full = await pumble.fetchMessage(
        config.appKey,
        workspaceTokens.botToken,
        event.channelId,
        event.messageId,
      );
      const raw = (full.message ?? full) as Record<string, unknown>;
      const quoted = raw.quote;
      if (
        !event.quote &&
        quoted &&
        typeof quoted === "object" &&
        !Array.isArray(quoted)
      ) {
        const record = quoted as Record<string, unknown>;
        const quotedText = stringValue(record.text);
        if (quotedText) {
          event.quote = {
            text: quotedText,
            authorId: stringValue(record.authorId) || undefined,
            messageId: stringValue(record.messageId) || undefined,
          };
        }
      }
      if (event.files.length === 0) {
        const fetched = parseMessageFiles(raw.files);
        if (fetched.length > 0) event.files = fetched;
      }
    } catch (error) {
      console.warn(
        ">>> Pumble message fetch failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Same lookup for the quoted message's author, so a quote reads as a name
  // rather than an id. Also cosmetic and also non-fatal.
  let quoteAuthorDisplayName = "";
  if (event.quote?.authorId) {
    if (event.quote.authorId === event.authorId) {
      quoteAuthorDisplayName = authorDisplayName;
    } else {
      try {
        const quotedUser = await pumble.getUser(
          config.appKey,
          workspaceTokens.botToken,
          event.quote.authorId,
        );
        quoteAuthorDisplayName =
          stringValue(quotedUser.name) ||
          stringValue(quotedUser.displayName) ||
          stringValue(quotedUser.username) ||
          "";
      } catch {
        // Falls back to the author id inside the rendered quote.
      }
    }
  }

  // Download attachments.
  const filesEvent: PumbleMessageFilesEvent = {
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    authorId: event.authorId,
    messageId: event.messageId,
    threadRootId: event.threadRootId,
    files: event.files,
  };
  let savedFiles;
  try {
    savedFiles = await savePumbleFiles(
      config,
      pumble,
      workspaceTokens,
      filesEvent,
    );
  } catch (error) {
    return {
      ok: false,
      error: `attachment download failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Check for download failures (individual file errors).
  const failedDownloads = savedFiles.filter((f) => f.error);
  if (failedDownloads.length > 0) {
    return {
      ok: false,
      error: `attachment download failed: ${failedDownloads.map((f) => f.error).join("; ")}`,
    };
  }

  // Build attachment refs for the inbound message.
  const attachments = savedFiles
    .filter((f) => f.workspacePath)
    .map((f) => ({
      path: f.workspacePath!,
      ...(f.name ? { name: f.name } : {}),
      ...(f.mimeType ? { mediaType: f.mimeType } : {}),
    }));

  // A thread counts as the agent's conversation when its ROOT addressed the
  // agent: someone opened it by tagging the bot, so the whole thread is
  // theirs and follow-ups need no repeated mention.
  //
  // Deliberately not "the agent has spoken here": replying once to a tagged
  // message inside someone else's thread would then capture that thread
  // forever. There the tag activates that message only, exactly like a
  // channel.
  // In a DM every message is already addressed, threads included, so skip the
  // lookup there.
  const threadAddressedAgent =
    event.threadRootId && channelType.toUpperCase() !== "DIRECT"
      ? await isThreadRootAddressedToAgent(
          event.channelId,
          event.threadRootId,
          workspaceTokens,
        )
      : false;

  // Normalize the Pumble message into the inbound contract.
  const normalizeContext: NormalizeContext = {
    botId: workspaceTokens.botId,
    channelType,
    authorDisplayName,
    attachments,
    quoteAuthorDisplayName,
    threadParticipant: threadAddressedAgent,
  };
  const inboundMessage = normalizePumbleMessage(event, normalizeContext);
  if (!inboundMessage) {
    // Dropped (ephemeral, echo, bot-authored, empty): ack so Pumble does not retry.
    return { ok: true };
  }

  // Validate core integration config.
  if (!config.coreUrl) {
    return {
      ok: false,
      error: "PUMBLE_CORE_URL is not configured",
    };
  }
  if (!config.coreSharedSecret) {
    return {
      ok: false,
      error: "PUMBLE_CORE_SHARED_SECRET is not configured",
    };
  }

  // Resolve the target for outbound callbacks.
  //
  // Replying in a channel starts a thread on the triggering message, so an
  // answer does not push unrelated conversation up the channel. An existing
  // thread root always wins: a reply to a threaded message belongs in that
  // same thread. DMs stay inline, where threading only adds a click.
  const isDirect = channelType.toUpperCase() === "DIRECT";
  const threadRepliesInChannels = settings.get().threadRepliesInChannels;
  const threadRootId =
    event.threadRootId ??
    (threadRepliesInChannels && !isDirect ? event.messageId : undefined);
  const target: Target = {
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    triggerMessageId: event.messageId,
    threadRootId,
    direct: isDirect,
  };

  // Serialize the target save, core POST, and correlation binding for this
  // conversation. Different conversations can proceed concurrently.
  return targetStore.serializeConversation(
    inboundMessage.conversationKey,
    async () => {
      // Persist target under conversationKey BEFORE the core POST so an early
      // outbound callback can resolve via conversationKey fallback.
      await targetStore.putByConversation(
        inboundMessage.conversationKey,
        target,
      );

      // POST the inbound message to the omp-bundler core.
      const body = JSON.stringify(inboundMessage);
      let correlationId: string;
      try {
        correlationId = await postToCore(body);
      } catch (error) {
        return {
          ok: false,
          error: `core POST failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      // Bind the returned correlationId to the same target AFTER acceptance.
      await targetStore.bindCorrelation(
        inboundMessage.conversationKey,
        correlationId,
      );

      return { ok: true };
    },
  );
}

/**
 * POST the inbound message to the omp-bundler core endpoint and validate
 * the acceptance response. Returns the correlationId on success.
 */
async function postToCore(body: string): Promise<string> {
  const endpoint = `${config.coreUrl}/v1/adapters/${config.coreAdapterId}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": INBOUND_MESSAGE_MEDIA_TYPE,
      [INBOUND_SECRET_HEADER]: config.coreSharedSecret,
    },
    body,
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });

  if (response.status === 202 || response.status === 200) {
    const payload = (await response.json()) as {
      status: string;
      correlationId: string;
    };
    if (payload.status !== "accepted" && payload.status !== "duplicate") {
      throw new Error(`core returned unexpected status: ${payload.status}`);
    }
    if (!payload.correlationId) {
      throw new Error("core returned empty correlationId");
    }
    return payload.correlationId;
  }

  // 409 conflict: same messageId with different payload. Not retryable.
  if (response.status === 409) {
    throw new Error(`core rejected: conflict (409)`);
  }

  // 4xx (other than 409): bad request, not retryable.
  if (response.status >= 400 && response.status < 500) {
    throw new Error(`core rejected: HTTP ${response.status}`);
  }

  // 5xx: retryable.
  const text = await response.text().catch(() => "");
  throw new Error(
    `core returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Core outbound callback: /core/events
// ---------------------------------------------------------------------------

/**
 * Terminal event types: each one closes a correlation, so the stored target
 * can be released. Kept in one place because missing a type here leaks a
 * target for every affected turn.
 */
const TERMINAL_EVENT_TYPES: Record<string, true> = {
  "turn.reply": true,
  "turn.error": true,
  "turn.cancelled": true,
};

function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES[type] === true;
}

async function handleCoreEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const rawBody = await readBody(req, config.coreEventMaxBytes);
  if (!rawBody) {
    sendText(res, 413, "Request body exceeds maximum size");
    return;
  }

  // Verify the exact-body HMAC signature.
  const signatureHeader = headerValue(
    req.headers[OUTBOUND_EVENT_SIGNATURE_HEADER.toLowerCase()],
  );
  if (
    !signatureHeader ||
    !verifyCoreSignature(signatureHeader, rawBody, config.coreSharedSecret)
  ) {
    sendText(res, 401, "Invalid signature");
    return;
  }

  // Verify content type.
  const contentType = headerValue(req.headers["content-type"]);
  if (contentType !== OUTBOUND_EVENT_MEDIA_TYPE) {
    sendText(
      res,
      415,
      `Unsupported media type; expected ${OUTBOUND_EVENT_MEDIA_TYPE}`,
    );
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  // Validate the v1 event shape.
  const validationError = validateOutboundEvent(payload);
  if (validationError) {
    sendText(res, 400, validationError);
    return;
  }

  const event = payload as unknown as OutboundEvent;

  if (await deliveryStore.hasCompleted(event.eventId)) {
    if (isTerminalEvent(event.type)) {
      await targetStore.forgetCorrelation(event.correlationId);
    }
    sendText(res, 200, "ok");
    return;
  }
  // Deliver the event through the renderer. It persists each confirmed side
  // effect before returning. Only 2xx after final event completion is durable.
  try {
    await renderer.render(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble renderer failed:", message);
    sendText(res, 500, "rendering failed");
    return;
  }

  // Persist dedupe before acknowledging; terminal targets can then be released.
  await deliveryStore.markCompleted(event.eventId);

  if (isTerminalEvent(event.type)) {
    await targetStore.forgetCorrelation(event.correlationId);
  }

  sendText(res, 200, "ok");
}

/**
 * Verify the core outbound signature: the header is `sha256=<hex>` and the
 * digest is HMAC-SHA256(sharedSecret, exactRequestBody) using the same
 * shared secret as the inbound auth.
 */
function verifyCoreSignature(
  sigHeader: string,
  rawBody: Buffer,
  secret: string,
): boolean {
  if (!secret) {
    return false;
  }
  const prefix = "sha256=";
  if (!sigHeader.startsWith(prefix)) {
    return false;
  }
  const provided = sigHeader.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Validate the minimal v1 outbound event shape. Checks the required base
 * fields and the discriminated variant fields without full schema validation.
 */
function validateOutboundEvent(
  payload: Record<string, unknown>,
): string | null {
  if (payload.version !== ADAPTER_API_VERSION) {
    return `version must be "${ADAPTER_API_VERSION}"`;
  }
  const type = payload.type;
  if (typeof type !== "string") {
    return "type must be a string";
  }
  const validTypes: Record<string, true> = {
    "turn.started": true,
    "turn.progress": true,
    "turn.delta": true,
    "turn.reply": true,
    "presence.changed": true,
    "turn.error": true,
    "turn.cancelled": true,
  };
  if (!validTypes[type]) {
    return `unknown event type: ${type}`;
  }
  if (typeof payload.eventId !== "string" || !payload.eventId) {
    return "eventId must be a non-empty string";
  }
  if (typeof payload.conversationKey !== "string" || !payload.conversationKey) {
    return "conversationKey must be a non-empty string";
  }
  if (typeof payload.correlationId !== "string" || !payload.correlationId) {
    return "correlationId must be a non-empty string";
  }
  if (
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 1
  ) {
    return "sequence must be a positive integer";
  }
  if (typeof payload.occurredAt !== "string" || !payload.occurredAt) {
    return "occurredAt must be a non-empty string";
  }

  if (
    type === "turn.progress" &&
    (typeof payload.message !== "string" || !payload.message)
  ) {
    return "turn.progress requires a non-empty message";
  }
  if (
    type === "turn.delta" &&
    (typeof payload.text !== "string" || payload.text.length === 0)
  ) {
    return "turn.delta requires a non-empty text";
  }
  if (type === "turn.reply") {
    if (typeof payload.text !== "string") {
      return "turn.reply requires a string text";
    }
    if (!Array.isArray(payload.attachments)) {
      return "turn.reply requires an attachments array";
    }
  }
  if (type === "turn.error") {
    if (typeof payload.code !== "string" || !payload.code) {
      return "turn.error requires a non-empty code";
    }
    if (typeof payload.message !== "string") {
      return "turn.error requires a string message";
    }
    if (typeof payload.retryable !== "boolean") {
      return "turn.error requires a boolean retryable";
    }
  }
  if (type === "presence.changed") {
    const presence = payload.presence;
    const validPresence: Record<string, true> = {
      active: true,
      idle: true,
      offline: true,
    };
    if (typeof presence !== "string" || !validPresence[presence]) {
      return "presence.changed requires a valid presence value";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signed download route: GET /download
// ---------------------------------------------------------------------------

async function handleDownload(url: URL, res: http.ServerResponse) {
  const queryPath = url.searchParams.get("p") || "";
  const queryExp = url.searchParams.get("exp") || "";
  const querySig = url.searchParams.get("sig") || "";

  let verifiedPath: string;
  try {
    verifiedPath = PumbleAttachmentSender.verifyDownloadLink(
      config,
      queryPath,
      queryExp,
      querySig,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Expired or tampered links are 403 (forbidden), not 500.
    sendText(res, 403, message);
    return;
  }

  let absolutePath: string;
  let file: FileHandle;
  let directory: FileHandle | undefined;
  try {
    absolutePath = await PumbleAttachmentSender.resolveWorkspacePathStatic(
      config,
      verifiedPath,
    );
    const expectedDirectory = path.dirname(absolutePath);
    directory = await open(
      expectedDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryRef = secureDirectoryReference(directory.fd);
    const openedDirectory = await realpath(directoryRef);
    const workspaceRoot = await realpath(path.dirname(config.pumbleFileDir));
    assertContained(workspaceRoot, openedDirectory);
    if (openedDirectory !== expectedDirectory) {
      throw new Error("Attachment directory changed while opening it");
    }
    file = await open(
      path.join(directoryRef, path.basename(absolutePath)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    sendText(res, 404, "File not found");
    return;
  } finally {
    await directory?.close();
  }
  let fileStat: Stats;
  try {
    fileStat = await file.stat();
  } catch {
    await file.close();
    sendText(res, 404, "File not found");
    return;
  }
  if (!fileStat.isFile()) {
    await file.close();
    sendText(res, 403, "Requested path is not a regular file");
    return;
  }
  if (fileStat.size > config.downloadMaxBytes) {
    await file.close();
    sendText(res, 403, "File exceeds maximum download size");
    return;
  }

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(fileStat.size),
  });
  const stream = file.createReadStream({ autoClose: true });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Attachment path escapes workspace root");
  }
}

function secureDirectoryReference(fd: number): string {
  if (process.platform !== "linux") {
    throw new Error(
      "Secure attachment serving requires the Linux container runtime",
    );
  }
  return `/proc/self/fd/${fd}`;
}

function pruneOAuthStates() {
  const now = Date.now();
  for (const [state, entry] of oauthStates) {
    if (entry.expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
}

function consumeOAuthState(state: string, nonce: string): boolean {
  if (!state || !nonce) {
    return false;
  }
  const entry = oauthStates.get(state);
  if (!entry || !safeEqual(entry.nonce, nonce)) {
    pruneOAuthStates();
    return false;
  }
  oauthStates.delete(state);
  return entry.expiresAt > Date.now();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function cookieValue(
  header: string | string[] | undefined,
  name: string,
): string {
  const prefix = `${name}=`;
  for (const part of headerValue(header).split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length);
    }
  }
  return "";
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
