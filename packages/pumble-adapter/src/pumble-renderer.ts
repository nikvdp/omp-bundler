import type {
  OutboundEvent,
  PresenceChangedEvent,
  TurnErrorEvent,
  TurnProgressEvent,
  TurnReplyEvent,
  TurnStartedEvent,
} from "@omp-bundler/contracts/outbound";
import type { WorkspaceAttachment } from "@omp-bundler/contracts/shared";
import type { PumbleApi } from "./pumble-api.js";

/**
 * Pumble outbound renderer.
 *
 * Consumes the omp-bundler {@link OutboundEvent} stream and translates each
 * event into concrete Pumble side effects on the channel identified by the
 * injected {@link ConversationResolver}. The renderer is stateful but keeps
 * correlation state in memory; the adapter service owns durable event-id
 * dedupe across restarts. Within one process it also checkpoints partial
 * terminal delivery so a retry does not repeat completed steps.
 *
 * Side effect policy
 * ------------------
 *   - turn.started   : adds one "working" reaction (eyes) on the triggering
 *                      message. Best-effort; a failed reaction never blocks the
 *                      turn.
 *   - turn.progress  : the first progress event posts one substantive interim
 *                      message (threaded when the resolver provides a thread
 *                      root). Every later progress event edits that same
 *                      interim message in place. There is no timer: the
 *                      renderer reacts to events at emitter thresholds.
 *                      Progress is best-effort and never terminal.
 *   - turn.reply     : posts exactly one final message, threaded when needed.
 *                      Output attachments are delivered through the injected
 *                      {@link AttachmentSender} when present. Without a sender,
 *                      or on a per-attachment send failure, the renderer posts a
 *                      best-effort visible notice and then rejects so the core
 *                      retries the durable redelivery; attachments are never
 *                      silently dropped. The correlation is marked terminal only
 *                      once the text and every attachment are delivered.
 *   - turn.error     : posts the curated error message as the final message.
 *   - presence       : maps active/idle/offline to a low-noise reaction policy
 *                      on the triggering message (a single working reaction that
 *                      transitions between eyes and hourglass, then clears on
 *                      offline). Pumble exposes no bot typing or presence
 *                      endpoints, so reactions stand in for presence.
 *
 * A terminal event (reply or error) closes the correlation within this
 * renderer: subsequent events for the same correlation, including late
 * presence, are ignored, and the working reaction is cleared.
 *
 * Failure semantics
 * -----------------
 * The durable side effects (the final reply or error message, and attachment
 * delivery) are the only operations that can reject from {@link render}: a
 * failed target resolution, final post, or attachment delivery bubbles out so
 * the caller can choose not to acknowledge and let the core retry the durable
 * redelivery. Reactions and progress are best-effort and never reject. The
 * renderer keeps per-correlation checkpoints (text posted, attachment indexes
 * sent) so an in-process retry skips work already completed. Server-level
 * persistent event-id dedupe suppresses events completed before a restart.
 */

/** Working/active reaction: "looking at this". */
const ACTIVE_REACTION = "\u{1F440}";

/** Idle reaction: "waiting". */
const IDLE_REACTION = "\u{23F3}";

/**
 * Conversation target resolved for a correlation. Produced by the injected
 * resolver; the renderer never parses `conversationKey`.
 */
export interface ResolvedTarget {
  appKey: string;
  botToken: string;
  channelId: string;
  triggerMessageId: string;
  threadRootId?: string;
}

/**
 * Maps an opaque `(conversationKey, correlationId)` pair to the Pumble channel
 * context the renderer needs to act. Returns `null` when no target is known;
 * the renderer then skips side effects and logs a warning.
 */
export type ConversationResolver = (
  conversationKey: string,
  correlationId: string,
) => Promise<ResolvedTarget | null>;

/** Minimal logger surface the renderer depends on. */
export interface RendererLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Seam for delivering a workspace output attachment into Pumble. The renderer
 * delegates byte transport entirely to the sender; when absent, attachment
 * delivery fails loudly instead of silently dropping files. Pumble upload is an
 * adapter concern owned by the sender implementation, not by this renderer.
 */
export interface AttachmentSender {
  send(target: ResolvedTarget, attachment: WorkspaceAttachment): Promise<void>;
}

/** Construction dependencies. Credentials are resolved per workspace target. */
export interface PumbleRendererOptions {
  pumble: PumbleApi;
  resolver: ConversationResolver;
  logger: RendererLogger;
  /** Optional; when omitted attachment delivery fails loudly. */
  attachmentSender?: AttachmentSender;
}

/** In-memory per-correlation delivery checkpoints. */
interface CorrelationState {
  /** Event ids already applied within this process, for in-memory dedupe. */
  seen: Set<string>;
  /** Whether the started reaction was already attempted. */
  startedReaction: boolean;
  /** Current working reaction emoji on the trigger message, if any. */
  workingEmoji?: string;
  /** Id of the first interim progress message, reused by later edits. */
  interimMessageId?: string;
  /**
   * Checkpoint for an in-flight terminal reply: the final text message has
   * been posted. A retry of the same event skips re-posting the text.
   */
  finalTextPosted: boolean;
  /**
   * Attachment indexes already handed to the sender for the in-flight
   * terminal reply. A retry skips these so files are not re-sent.
   */
  sentAttachmentIndexes: Set<number>;
  /** True only once a terminal reply or error is fully delivered. */
  terminal: boolean;
  /** Promise chain serializing per-correlation invocations. */
  chain: Promise<void>;
}

export class PumbleRenderer {
  private readonly pumble: PumbleApi;
  private readonly resolver: ConversationResolver;
  private readonly logger: RendererLogger;
  private readonly attachmentSender?: AttachmentSender;

  /** Nested map keyed by (conversationKey, correlationId), never concatenation. */
  private readonly correlations = new Map<string, Map<string, CorrelationState>>();

  constructor(options: PumbleRendererOptions) {
    this.pumble = options.pumble;
    this.resolver = options.resolver;
    this.logger = options.logger;
    this.attachmentSender = options.attachmentSender;
  }

  /**
   * Apply one outbound event. Serializes per correlation so side effects for a
   * single `(conversationKey, correlationId)` never interleave. Resolves for
   * best-effort operations; rejects when a durable final message could not be
   * posted, when terminal target resolution fails, or when an attachment could
   * not be delivered, so the caller can withhold acknowledgment and let the
   * core retry the durable redelivery. Per-correlation checkpoints make an
   * in-process retry skip already-posted text and already-sent attachments.
   */
  async render(event: OutboundEvent): Promise<void> {
    const state = this.stateFor(event.conversationKey, event.correlationId);
    const next = state.chain
      .catch(() => {
        // A prior invocation's rejection must not block this one.
      })
      .then(() => this.apply(event, state));
    state.chain = next;
    return next;
  }

  private stateFor(conversationKey: string, correlationId: string): CorrelationState {
    let perConversation = this.correlations.get(conversationKey);
    if (!perConversation) {
      perConversation = new Map();
      this.correlations.set(conversationKey, perConversation);
    }
    let state = perConversation.get(correlationId);
    if (!state) {
      state = {
        seen: new Set<string>(),
        startedReaction: false,
        finalTextPosted: false,
        sentAttachmentIndexes: new Set<number>(),
        terminal: false,
        chain: Promise.resolve(),
      };
      perConversation.set(correlationId, state);
    }
    return state;
  }

  private async apply(event: OutboundEvent, state: CorrelationState): Promise<void> {
    if (state.seen.has(event.eventId)) {
      return;
    }
    if (state.terminal) {
      return;
    }
    await this.dispatch(event, state);
    state.seen.add(event.eventId);
  }

  private async dispatch(event: OutboundEvent, state: CorrelationState): Promise<void> {
    switch (event.type) {
      case "turn.started":
        await this.onStarted(event, state);
        return;
      case "turn.progress":
        await this.onProgress(event, state);
        return;
      case "turn.reply":
        await this.onReply(event, state);
        return;
      case "turn.error":
        await this.onError(event, state);
        return;
      case "presence.changed":
        await this.onPresence(event, state);
        return;
    }
  }

  private async onStarted(event: TurnStartedEvent, state: CorrelationState): Promise<void> {
    if (state.startedReaction) {
      return;
    }
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    const ok = await this.safeAddReaction(target, ACTIVE_REACTION);
    state.startedReaction = true;
    if (ok) {
      state.workingEmoji = ACTIVE_REACTION;
    }
  }

  private async onProgress(event: TurnProgressEvent, state: CorrelationState): Promise<void> {
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    if (!state.interimMessageId) {
      try {
        const response = await this.pumble.sendMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          event.message,
          target.threadRootId,
        );
        const id = messageIdOf(response);
        if (id) {
          state.interimMessageId = id;
        } else {
          this.logger.warn(
            "pumble-renderer: progress interim posted but no message id returned",
            this.describeCorrelation(event),
          );
        }
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: progress interim post failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
    } else {
      try {
        await this.pumble.editMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          state.interimMessageId,
          event.message,
        );
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: progress edit failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
    }
  }

  private async onReply(event: TurnReplyEvent, state: CorrelationState): Promise<void> {
    const target = await this.resolveRequired(event);

    // Post the final text exactly once across in-process retries.
    if (event.text && !state.finalTextPosted) {
      await this.pumble.sendMessage(
        target.appKey,
        target.botToken,
        target.channelId,
        event.text,
        target.threadRootId,
      );
      state.finalTextPosted = true;
    }

    // Deliver every attachment exactly once; reject so the core retries the
    // durable redelivery when anything remains undelivered. Best-effort
    // notices are posted before rejecting so the failure is visible.
    await this.deliverAttachments(target, event.attachments, state);

    await this.clearWorkingReaction(target, state);
    state.terminal = true;
  }

  private async onError(event: TurnErrorEvent, state: CorrelationState): Promise<void> {
    this.logger.warn(
      "pumble-renderer: turn error",
      this.describeCorrelation(event),
      event.code,
      `retryable=${event.retryable}`,
    );
    const target = await this.resolveRequired(event);

    // The curated error message is the terminal message; a failed post rejects
    // so the core retries the durable redelivery.
    await this.pumble.sendMessage(
      target.appKey,
      target.botToken,
      target.channelId,
      event.message,
      target.threadRootId,
    );
    await this.clearWorkingReaction(target, state);
    state.terminal = true;
  }

  private async onPresence(
    event: PresenceChangedEvent,
    state: CorrelationState,
  ): Promise<void> {
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    const presence = event.presence;
    if (presence === "active") {
      await this.setWorkingEmoji(target, state, ACTIVE_REACTION);
    } else if (presence === "idle") {
      await this.setWorkingEmoji(target, state, IDLE_REACTION);
    } else {
      await this.clearWorkingReaction(target, state);
    }
  }

  private async setWorkingEmoji(
    target: ResolvedTarget,
    state: CorrelationState,
    emoji: string,
  ): Promise<void> {
    if (state.workingEmoji === emoji) {
      return;
    }
    if (state.workingEmoji) {
      await this.safeRemoveReaction(target, state.workingEmoji);
    }
    const ok = await this.safeAddReaction(target, emoji);
    if (ok) {
      state.workingEmoji = emoji;
    }
  }

  private async clearWorkingReaction(
    target: ResolvedTarget,
    state: CorrelationState,
  ): Promise<void> {
    if (!state.workingEmoji) {
      return;
    }
    await this.safeRemoveReaction(target, state.workingEmoji);
    state.workingEmoji = undefined;
  }

  private async deliverAttachments(
    target: ResolvedTarget,
    attachments: WorkspaceAttachment[],
    state: CorrelationState,
  ): Promise<void> {
    if (attachments.length === 0) {
      return;
    }
    if (!this.attachmentSender) {
      this.logger.error(
        "pumble-renderer: reply included attachments but no attachment sender is configured",
        attachments.length,
      );
      await this.safeSendNotice(
        target,
        `This reply included ${attachments.length} attachment(s) but attachment delivery is not configured for this adapter.`,
      );
      throw new Error(
        `attachments present but no AttachmentSender is configured (${attachments.length} undelivered)`,
      );
    }
    for (let index = 0; index < attachments.length; index++) {
      if (state.sentAttachmentIndexes.has(index)) {
        continue;
      }
      const attachment = attachments[index];
      try {
        await this.attachmentSender.send(target, attachment);
        state.sentAttachmentIndexes.add(index);
      } catch (error) {
        const label = attachment.name || attachment.path;
        this.logger.error(
          "pumble-renderer: attachment delivery failed",
          attachment.path,
          this.errorText(error),
        );
        await this.safeSendNotice(target, `Failed to deliver attachment "${label}".`);
        throw error;
      }
    }
  }

  private async resolve(event: OutboundEvent): Promise<ResolvedTarget | null> {
    let target: ResolvedTarget | null;
    try {
      target = await this.resolver(event.conversationKey, event.correlationId);
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: resolver threw",
        this.describeCorrelation(event),
        this.errorText(error),
      );
      return null;
    }
    if (!target) {
      this.logger.warn("pumble-renderer: no target resolved", this.describeCorrelation(event));
      return null;
    }
    return target;
  }

  private async resolveRequired(event: OutboundEvent): Promise<ResolvedTarget> {
    let target: ResolvedTarget | null;
    try {
      target = await this.resolver(event.conversationKey, event.correlationId);
    } catch (error) {
      this.logger.error(
        "pumble-renderer: resolver threw for terminal event",
        this.describeCorrelation(event),
        this.errorText(error),
      );
      throw error;
    }
    if (!target) {
      this.logger.error(
        "pumble-renderer: no target resolved for terminal event",
        this.describeCorrelation(event),
      );
      throw new Error(
        `no target resolved for terminal event (${this.describeCorrelation(event)})`,
      );
    }
    return target;
  }

  private async safeAddReaction(target: ResolvedTarget, emoji: string): Promise<boolean> {
    try {
      await this.pumble.addReaction(
        target.appKey,
        target.botToken,
        target.channelId,
        target.triggerMessageId,
        emoji,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: add reaction failed",
        emoji,
        this.errorText(error),
      );
      return false;
    }
  }

  private async safeRemoveReaction(
    target: ResolvedTarget,
    emoji: string,
  ): Promise<void> {
    try {
      await this.pumble.removeReaction(
        target.appKey,
        target.botToken,
        target.channelId,
        target.triggerMessageId,
        emoji,
      );
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: remove reaction failed",
        emoji,
        this.errorText(error),
      );
    }
  }

  private async safeSendNotice(target: ResolvedTarget, text: string): Promise<void> {
    try {
      await this.pumble.sendMessage(
        target.appKey,
        target.botToken,
        target.channelId,
        text,
        target.threadRootId,
      );
    } catch (error) {
      this.logger.error("pumble-renderer: failure notice post failed", this.errorText(error));
    }
  }

  private describeCorrelation(event: OutboundEvent): string {
    return `conversationKey=${event.conversationKey} correlationId=${event.correlationId} sequence=${event.sequence}`;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Extracts the id of a message created by {@link PumbleApi.sendMessage} from
 * the parsed response. Pumble returns the created message id at the top level
 * (or nested under `message`); this helper tolerates both shapes.
 */
function messageIdOf(response: Record<string, unknown>): string | undefined {
  for (const candidate of [response.id, response.messageId]) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  const message = response.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const nested = message as Record<string, unknown>;
    for (const candidate of [nested.id, nested.messageId]) {
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
    }
  }
  return undefined;
}