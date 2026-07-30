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
 * injected {@link ConversationResolver}. Correlation state stays in memory;
 * the adapter service owns durable event-id completion and per-effect
 * checkpoints across restarts.
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
 *   - turn.reply     : posts the final message, threaded when needed. Confirmed
 *                      text and attachment effects are checkpointed before the
 *                      whole event is completed. Output attachments are
 *                      delivered through the injected {@link AttachmentSender}
 *                      when present. Without a sender, or on a per-attachment
 *                      send failure, the renderer posts a best-effort visible
 *                      notice and then rejects so the core retries the durable
 *                      redelivery; attachments are never silently dropped.
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
 * Failed target resolution, a final post, attachment delivery, or checkpoint
 * persistence rejects from {@link render} so the caller does not acknowledge
 * incomplete durable state. Pumble API failures for reactions and progress
 * remain best-effort. The renderer combines in-memory correlation state with
 * durable per-event checkpoints so retries skip effects already confirmed and
 * recorded.
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

/** Durable per-event rendering progress used to resume interrupted delivery. */
export interface RenderingCheckpointStore {
  checkpointsFor(eventId: string): Promise<ReadonlySet<string>>;
  markCheckpoint(eventId: string, checkpoint: string): Promise<void>;
}

/** Construction dependencies. Credentials are resolved per workspace target. */
export interface PumbleRendererOptions {
  pumble: PumbleApi;
  resolver: ConversationResolver;
  logger: RendererLogger;
  /** Optional; when omitted attachment delivery fails loudly. */
  attachmentSender?: AttachmentSender;
  /** Optional persistent checkpoints for confirmed Pumble side effects. */
  checkpointStore?: RenderingCheckpointStore;
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
  private readonly checkpointStore?: RenderingCheckpointStore;

  /** Nested map keyed by (conversationKey, correlationId), never concatenation. */
  private readonly correlations = new Map<
    string,
    Map<string, CorrelationState>
  >();

  constructor(options: PumbleRendererOptions) {
    this.pumble = options.pumble;
    this.resolver = options.resolver;
    this.logger = options.logger;
    this.attachmentSender = options.attachmentSender;
    this.checkpointStore = options.checkpointStore;
  }

  /**
   * Apply one outbound event. Serializes per correlation so side effects for a
   * single `(conversationKey, correlationId)` never interleave. Resolves for
   * best-effort operations; rejects when a durable final message could not be
   * posted, when terminal target resolution fails, or when an attachment could
   * not be delivered, so the caller can withhold acknowledgment and let the
   * core retry the durable redelivery. Confirmed side effects are checkpointed
   * before completion so a restart can resume them, while the unavoidable gap
   * between Pumble confirmation and the checkpoint remains at-least-once.
   */
  async render(event: OutboundEvent): Promise<void> {
    const state = this.stateFor(event.conversationKey, event.correlationId);
    const next = state.chain
      .catch(() => {
        // A prior invocation's rejection must not block this one.
      })
      .then(async () => {
        const checkpoints = new Set<string>(
          this.checkpointStore
            ? await this.checkpointStore.checkpointsFor(event.eventId)
            : undefined,
        );
        await this.apply(event, state, checkpoints);
      });
    state.chain = next;
    return next;
  }

  private stateFor(
    conversationKey: string,
    correlationId: string,
  ): CorrelationState {
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

  private async apply(
    event: OutboundEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    if (state.seen.has(event.eventId)) {
      return;
    }
    if (state.terminal) {
      return;
    }
    await this.dispatch(event, state, checkpoints);
    state.seen.add(event.eventId);
  }

  private async dispatch(
    event: OutboundEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    switch (event.type) {
      case "turn.started":
        await this.onStarted(event, state, checkpoints);
        return;
      case "turn.progress":
        await this.onProgress(event, state, checkpoints);
        return;
      case "turn.reply":
        await this.onReply(event, state, checkpoints);
        return;
      case "turn.error":
        await this.onError(event, state, checkpoints);
        return;
      case "presence.changed":
        await this.onPresence(event, state, checkpoints);
        return;
    }
  }

  private async onStarted(
    event: TurnStartedEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const checkpoint = `reaction:add:${ACTIVE_REACTION}`;
    if (checkpoints.has(checkpoint)) {
      state.startedReaction = true;
      state.workingEmoji = ACTIVE_REACTION;
      return;
    }
    if (state.startedReaction) {
      await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
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
      await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
    }
  }

  private async onProgress(
    event: TurnProgressEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const checkpoint = "text";
    if (checkpoints.has(checkpoint)) {
      return;
    }
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    let confirmed = false;
    if (!state.interimMessageId) {
      try {
        const response = await this.pumble.sendMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          event.message,
          target.threadRootId,
        );
        confirmed = true;
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
        confirmed = true;
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: progress edit failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
    }
    if (confirmed) {
      await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
    }
  }

  private async onReply(
    event: TurnReplyEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const target = await this.resolveRequired(event);

    if (event.text) {
      if (checkpoints.has("text")) {
        state.finalTextPosted = true;
      } else if (state.finalTextPosted) {
        await this.markCheckpoint(event.eventId, checkpoints, "text");
      } else {
        await this.pumble.sendMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          event.text,
          target.threadRootId,
        );
        state.finalTextPosted = true;
        await this.markCheckpoint(event.eventId, checkpoints, "text");
      }
    }

    await this.deliverAttachments(target, event, state, checkpoints);
    await this.clearWorkingReaction(target, state, event.eventId, checkpoints);
    state.terminal = true;
  }

  private async onError(
    event: TurnErrorEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    this.logger.warn(
      "pumble-renderer: turn error",
      this.describeCorrelation(event),
      event.code,
      `retryable=${event.retryable}`,
    );
    const target = await this.resolveRequired(event);

    if (!checkpoints.has("text")) {
      await this.pumble.sendMessage(
        target.appKey,
        target.botToken,
        target.channelId,
        event.message,
        target.threadRootId,
      );
      await this.markCheckpoint(event.eventId, checkpoints, "text");
    }
    await this.clearWorkingReaction(target, state, event.eventId, checkpoints);
    state.terminal = true;
  }

  private async onPresence(
    event: PresenceChangedEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    const presence = event.presence;
    if (presence === "active") {
      await this.setWorkingEmoji(
        target,
        state,
        ACTIVE_REACTION,
        event.eventId,
        checkpoints,
      );
    } else if (presence === "idle") {
      await this.setWorkingEmoji(
        target,
        state,
        IDLE_REACTION,
        event.eventId,
        checkpoints,
      );
    } else {
      await this.clearWorkingReaction(
        target,
        state,
        event.eventId,
        checkpoints,
      );
    }
  }

  private async setWorkingEmoji(
    target: ResolvedTarget,
    state: CorrelationState,
    emoji: string,
    eventId: string,
    checkpoints: Set<string>,
  ): Promise<void> {
    const addCheckpoint = `reaction:add:${emoji}`;
    if (checkpoints.has(addCheckpoint)) {
      state.workingEmoji = emoji;
      return;
    }
    if (state.workingEmoji === emoji) {
      await this.markCheckpoint(eventId, checkpoints, addCheckpoint);
      return;
    }
    if (state.workingEmoji) {
      const removeCheckpoint = `reaction:remove:${state.workingEmoji}`;
      if (!checkpoints.has(removeCheckpoint)) {
        const removed = await this.safeRemoveReaction(
          target,
          state.workingEmoji,
        );
        if (removed) {
          await this.markCheckpoint(eventId, checkpoints, removeCheckpoint);
        }
      }
    }
    const ok = await this.safeAddReaction(target, emoji);
    if (ok) {
      state.workingEmoji = emoji;
      await this.markCheckpoint(eventId, checkpoints, addCheckpoint);
    }
  }

  private async clearWorkingReaction(
    target: ResolvedTarget,
    state: CorrelationState,
    eventId: string,
    checkpoints: Set<string>,
  ): Promise<void> {
    if (!state.workingEmoji) {
      return;
    }
    const checkpoint = `reaction:remove:${state.workingEmoji}`;
    if (!checkpoints.has(checkpoint)) {
      const removed = await this.safeRemoveReaction(target, state.workingEmoji);
      if (removed) {
        await this.markCheckpoint(eventId, checkpoints, checkpoint);
      }
    }
    state.workingEmoji = undefined;
  }

  private async deliverAttachments(
    target: ResolvedTarget,
    event: TurnReplyEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const attachments = event.attachments;
    if (attachments.length === 0) {
      return;
    }
    if (!this.attachmentSender) {
      this.logger.error(
        "pumble-renderer: reply included attachments but no attachment sender is configured",
        attachments.length,
      );
      const checkpoint = "notice:attachments-unconfigured";
      if (
        !checkpoints.has(checkpoint) &&
        (await this.safeSendNotice(
          target,
          `This reply included ${attachments.length} attachment(s) but attachment delivery is not configured for this adapter.`,
        ))
      ) {
        await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
      }
      throw new Error(
        `attachments present but no AttachmentSender is configured (${attachments.length} undelivered)`,
      );
    }
    for (let index = 0; index < attachments.length; index++) {
      const checkpoint = `attachment:${index}`;
      if (checkpoints.has(checkpoint)) {
        state.sentAttachmentIndexes.add(index);
        continue;
      }
      if (state.sentAttachmentIndexes.has(index)) {
        await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
        continue;
      }
      const attachment = attachments[index];
      try {
        await this.attachmentSender.send(target, attachment);
      } catch (error) {
        const label = attachment.name || attachment.path;
        this.logger.error(
          "pumble-renderer: attachment delivery failed",
          attachment.path,
          this.errorText(error),
        );
        const noticeCheckpoint = `notice:attachment:${index}:failed`;
        if (
          !checkpoints.has(noticeCheckpoint) &&
          (await this.safeSendNotice(
            target,
            `Failed to deliver attachment "${label}".`,
          ))
        ) {
          await this.markCheckpoint(
            event.eventId,
            checkpoints,
            noticeCheckpoint,
          );
        }
        throw error;
      }
      state.sentAttachmentIndexes.add(index);
      await this.markCheckpoint(event.eventId, checkpoints, checkpoint);
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
      this.logger.warn(
        "pumble-renderer: no target resolved",
        this.describeCorrelation(event),
      );
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

  private async safeAddReaction(
    target: ResolvedTarget,
    emoji: string,
  ): Promise<boolean> {
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
  ): Promise<boolean> {
    try {
      await this.pumble.removeReaction(
        target.appKey,
        target.botToken,
        target.channelId,
        target.triggerMessageId,
        emoji,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: remove reaction failed",
        emoji,
        this.errorText(error),
      );
      return false;
    }
  }

  private async safeSendNotice(
    target: ResolvedTarget,
    text: string,
  ): Promise<boolean> {
    try {
      await this.pumble.sendMessage(
        target.appKey,
        target.botToken,
        target.channelId,
        text,
        target.threadRootId,
      );
      return true;
    } catch (error) {
      this.logger.error(
        "pumble-renderer: failure notice post failed",
        this.errorText(error),
      );
      return false;
    }
  }

  private async markCheckpoint(
    eventId: string,
    checkpoints: Set<string>,
    checkpoint: string,
  ): Promise<void> {
    if (checkpoints.has(checkpoint)) {
      return;
    }
    await this.checkpointStore?.markCheckpoint(eventId, checkpoint);
    checkpoints.add(checkpoint);
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
