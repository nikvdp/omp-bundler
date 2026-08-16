import type {
  OutboundEvent,
  PresenceChangedEvent,
  TurnErrorEvent,
  TurnCancelledEvent,
  TurnDeltaEvent,
  TurnProgressEvent,
  TurnReplyEvent,
  TurnStartedEvent,
} from "@omp-bundler/contracts/outbound";
import type { WorkspaceAttachment } from "@omp-bundler/contracts/shared";
import type { PumbleApi } from "./pumble-api.js";
import type { SettingsStore } from "./settings.js";

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
 *   - turn.started   : adds both status reactions on the triggering message,
 *                      eyes ("seen") and speech balloon ("replying").
 *                      Best-effort and independent; a failed reaction never
 *                      blocks the turn.
 *   - turn.progress  : the first progress event posts one substantive interim
 *                      message (threaded when the resolver provides a thread
 *                      root). Every later progress event edits that same
 *                      interim message in place. There is no timer: the
 *                      renderer reacts to events at emitter thresholds.
 *                      Progress is best-effort and never terminal.
 *   - turn.delta     : intentionally no-op. The adapter validates, deduplicates,
 *                      and acknowledges the event without posting, editing, or
 *                      finalizing any Pumble message.
 *   - turn.reply     : posts the final message, threaded when needed. Confirmed
 *                      text and attachment effects are checkpointed before the
 *                      whole event is completed. Output attachments are
 *                      delivered through the injected {@link AttachmentSender}
 *                      when present. Without a sender, or on a per-attachment
 *                      send failure, the renderer posts a best-effort visible
 *                      notice and then rejects so the core retries the durable
 *                      redelivery; attachments are never silently dropped.
 *   - turn.error     : posts the curated error message as the final message.
 *   - presence       : no reactions. Presence is derived from the agent's own
 *                      turn lifecycle (turn_start -> active, agent_end ->
 *                      idle), so it says nothing a person cannot read from the
 *                      reply itself. `offline` clears both reactions, since the
 *                      agent died without replying and stale markers on a dead
 *                      turn are worse than clearing early.
 *
 * A terminal event (reply or error) closes the correlation within this
 * renderer: subsequent events for the same correlation, including late
 * presence, are ignored, and both status reactions are removed. Reactions
 * describe what is true right now; once the reply exists, neither "seen" nor
 * "replying" still holds, so leaving them would decorate every answered
 * message permanently.
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

/**
 * Status markers on the triggering message, in lifecycle order:
 *
 *   turn.started -> eyes            "I saw your message"
 *   turn.started -> brain           "I am working out a reply"
 *   first delta  -> brain removed, speech balloon added
 *   reply/error  -> all cleared
 *
 * Pumble takes a shortcode, not raw Unicode.
 */
const SEEN_REACTION = ":eyes:";
const THINKING_REACTION = ":brain:";
const REPLYING_REACTION = ":speech_balloon:";

/** Every status reaction, for bulk clearing at the end of a turn. */
const STATUS_REACTIONS = [
  SEEN_REACTION,
  THINKING_REACTION,
  REPLYING_REACTION,
] as const;

/**
 * Events that end a turn. These are the only ones that clear status markers,
 * and they do so from one place so a new terminal type cannot be added without
 * inheriting the cleanup.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn.reply",
  "turn.error",
  "turn.cancelled",
]);

function isTerminalEvent(event: OutboundEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * Minimum gap between interim edits. Deltas can arrive per token; editing
 * Pumble that often would flood the API for no readable benefit.
 */
const INTERIM_EDIT_INTERVAL_MS = 900;

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
  /** True when this conversation is a direct message. */
  direct?: boolean;
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
  /**
   * Runtime settings. Streaming is decided per message rather than at
   * construction, so the agent can change it mid-conversation and so a
   * channel and a DM can behave differently.
   */
  settings?: Pick<SettingsStore, "get">;
}

/** In-memory per-correlation delivery checkpoints. */
interface CorrelationState {
  /** Event ids already applied within this process, for in-memory dedupe. */
  seen: Set<string>;
  /** Whether the status reactions were already attempted for this turn. */
  startedReaction: boolean;
  /**
   * Status reactions currently believed to be on the trigger message. The two
   * markers are independent: eyes and speech balloon coexist during a turn,
   * and one failing to apply never affects the other.
   */
  activeReactions: Set<string>;

  /** Status reactions already attempted, including attempts that failed. */
  attemptedReactions: Set<string>;

  /** Id of the first interim progress message, reused by later edits. */
  interimMessageId?: string;
  /**
   * Running text shown in the interim message. `turn.progress` carries only
   * the newest chunk, not the reply so far, so the renderer accumulates here.
   * Without this each edit replaced the message with a single fragment.
   */
  interimText: string;
  /** Epoch ms of the last interim edit, for throttling. */
  lastInterimEditAt: number;
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
  private readonly settings?: Pick<SettingsStore, "get">;

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
    this.settings = options.settings;
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
        activeReactions: new Set<string>(),

        attemptedReactions: new Set<string>(),

        interimText: "",
        lastInterimEditAt: 0,
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
    // Status reactions are cleared here, not in each handler: a terminal event
    // must never leave the thinking/replying markers on the message, including
    // when the handler throws partway through. Clearing is idempotent and the
    // markers are the only thing a reader has to tell a live turn from a dead
    // one, so this runs even if delivery failed.
    try {
      await this.dispatch(event, state, checkpoints);
    } finally {
      if (isTerminalEvent(event)) {
        await this.clearTerminalStatus(event, state, checkpoints);
        state.terminal = true;
      }
    }
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
      case "turn.delta":
        // Deltas post nothing, but the first one marks the moment the model
        // stopped thinking and started writing.
        await this.onDelta(event, state, checkpoints);
        return;
      case "turn.reply":
        await this.onReply(event, state, checkpoints);
        return;
      case "turn.error":
        await this.onError(event, state, checkpoints);
        return;
      case "turn.cancelled":
        await this.onCancelled(event, state, checkpoints);
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
    // At turn start the model has not produced text yet, so the pair is
    // "seen" plus "thinking". The first delta swaps thinking for replying.
    // addStatusReaction is idempotent through its checkpoint, and each marker
    // is independent so one failing never suppresses the other.
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    state.startedReaction = true;
    for (const emoji of [SEEN_REACTION, THINKING_REACTION]) {
      await this.addStatusReaction(
        target,
        state,
        emoji,
        event.eventId,
        checkpoints,
      );
    }
  }

  /**
   * Handle one streamed text chunk.
   *
   * `turn.delta` is the real stream: emitted for every chunk, append-only, no
   * coalescing. `turn.progress` is a 500ms sampler that overwrites a single
   * pending slot, so chunks inside its window are lost and it can never show
   * the full reply. The interim message is therefore driven from deltas.
   *
   * Pumble is edited at most once per {@link INTERIM_EDIT_INTERVAL_MS} so a
   * fast stream does not turn into an edit-per-token flood. The accumulated
   * text is always complete; only the edit rate is throttled.
   */
  private async onDelta(
    event: TurnDeltaEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    state.interimText += event.text;

    if (!state.attemptedReactions.has(REPLYING_REACTION)) {
      const target = await this.resolve(event);
      if (target) {
        await this.removeStatusReaction(
          target,
          state,
          THINKING_REACTION,
          event.eventId,
          checkpoints,
        );
        await this.addStatusReaction(
          target,
          state,
          REPLYING_REACTION,
          event.eventId,
          checkpoints,
        );
      }
    }

    const now = Date.now();
    if (state.interimMessageId && now - state.lastInterimEditAt < INTERIM_EDIT_INTERVAL_MS) {
      return;
    }
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    // Resolved first: streaming is a per-conversation decision, and only the
    // target knows whether this is a DM.
    if (!this.streamingEnabled(target)) {
      return;
    }
    const body = state.interimText;
    if (!state.interimMessageId) {
      try {
        const response = await this.pumble.sendMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          body,
          target.threadRootId,
        );
        const id = messageIdOf(response);
        if (id) state.interimMessageId = id;
        state.lastInterimEditAt = now;
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: interim post failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
      return;
    }
    try {
      await this.pumble.editMessage(
        target.appKey,
        target.botToken,
        target.channelId,
        state.interimMessageId,
        body,
      );
      state.lastInterimEditAt = now;
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: interim edit failed",
        this.describeCorrelation(event),
        this.errorText(error),
      );
    }
  }

  private async onProgress(
    event: TurnProgressEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    // No-op. The interim message is driven by turn.delta, which carries every
    // chunk. turn.progress is a 500ms sampler whose pending slot is
    // overwritten between flushes, so acting on it both loses text and fights
    // the delta stream for the same message.
    void event;
    void state;
    void checkpoints;
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
        await this.deliverFinalText(target, state, event.text, event);
        state.finalTextPosted = true;
        await this.markCheckpoint(event.eventId, checkpoints, "text");
      }
    }

    // A silent turn that already streamed an interim would otherwise leave it
    // standing: a half-written thought the agent decided not to send. Remove
    // it so choosing silence actually looks silent.
    if (!event.text && state.interimMessageId) {
      try {
        await this.pumble.deleteMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          state.interimMessageId,
        );
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: silent interim delete failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
      state.interimMessageId = undefined;
    }

    await this.deliverAttachments(target, event, state, checkpoints);
  }

  /**
   * Deliver terminal text. When a streamed interim message is already in the
   * channel, edit it into the final text so the partial does not linger above
   * the real answer; otherwise post a new message. Falls back to posting if
   * the edit fails, because losing the answer is worse than a duplicate.
   */
  private async deliverFinalText(
    target: ResolvedTarget,
    state: CorrelationState,
    text: string,
    event: OutboundEvent,
  ): Promise<void> {
    if (state.interimMessageId) {
      try {
        await this.pumble.editMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          state.interimMessageId,
          text,
        );
        return;
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: final edit failed, posting a new message",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
    }
    await this.pumble.sendMessage(
      target.appKey,
      target.botToken,
      target.channelId,
      text,
      target.threadRootId,
    );
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
      await this.deliverFinalText(target, state, event.message, event);
      await this.markCheckpoint(event.eventId, checkpoints, "text");
    }
  }

  /**
   * A turn was abandoned because a newer addressed message replaced it.
   *
   * Core rewound the session past this turn, so any interim message already
   * posted has to go: leaving it would show a half-written reply that the
   * agent no longer has any record of. Nothing is posted in its place, since
   * the replacement turn is already running and will answer.
   */
  private async onCancelled(
    event: TurnCancelledEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    if (state.interimMessageId) {
      try {
        await this.pumble.deleteMessage(
          target.appKey,
          target.botToken,
          target.channelId,
          state.interimMessageId,
        );
      } catch (error) {
        this.logger.warn(
          "pumble-renderer: interim delete failed",
          this.describeCorrelation(event),
          this.errorText(error),
        );
      }
      state.interimMessageId = undefined;
    }
  }

  private async onPresence(
    event: PresenceChangedEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    // active/idle carry no information a person cannot read from the reply, so
    // they produce no reactions. offline means the agent died mid-turn: clear
    // the markers rather than leave them stranded on a turn that will never
    // finish.
    if (event.presence !== "offline") {
      return;
    }
    const target = await this.resolve(event);
    if (!target) {
      return;
    }
    await this.clearStatusReactions(target, state, event.eventId, checkpoints);
  }

  /**
   * Remove both status reactions. Each is guarded by its own checkpoint so a
   * retry does not re-issue a delete that already succeeded, and a failure on
   * one marker does not strand the other.
   */
  private async clearStatusReactions(
    target: ResolvedTarget,
    state: CorrelationState,
    eventId: string,
    checkpoints: Set<string>,
  ): Promise<void> {
    for (const emoji of STATUS_REACTIONS) {
      await this.removeStatusReaction(
        target,
        state,
        emoji,
        eventId,
        checkpoints,
      );
    }
  }

  /**
   * Clear status markers for a terminal event. Resolving the target can fail
   * (deleted channel, revoked token) and that must not propagate: the turn is
   * already over and the caller is in a `finally`, so throwing here would
   * replace the real outcome with a cleanup error.
   */
  private async clearTerminalStatus(
    event: OutboundEvent,
    state: CorrelationState,
    checkpoints: Set<string>,
  ): Promise<void> {
    try {
      const target = await this.resolveRequired(event);
      await this.clearStatusReactions(target, state, event.eventId, checkpoints);
    } catch (error) {
      this.logger.warn(
        "pumble-renderer: status cleanup failed",
        this.describeCorrelation(event),
        this.errorText(error),
      );
    }
  }

  /**
   * Add one status reaction and record it, unless a checkpoint says it is
   * already there. Shared by turn start and the thinking/replying swap so the
   * checkpoint key and state bookkeeping stay in one place.
   */
  private async addStatusReaction(
    target: ResolvedTarget,
    state: CorrelationState,
    emoji: string,
    eventId: string,
    checkpoints: Set<string>,
  ): Promise<void> {
    const checkpoint = `reaction:add:${emoji}`;
    if (state.attemptedReactions.has(emoji)) {
      return;
    }
    state.attemptedReactions.add(emoji);
    if (checkpoints.has(checkpoint)) {
      state.activeReactions.add(emoji);
      return;
    }
    if (await this.safeAddReaction(target, emoji)) {
      state.activeReactions.add(emoji);
      await this.markCheckpoint(eventId, checkpoints, checkpoint);
    }
  }

  /**
   * Remove one status reaction, mirroring {@link addStatusReaction}.
   *
   * Removal is not gated on `activeReactions`. That set is per-process memory:
   * a restart or a rebuilt correlation empties it while the reaction is still
   * on the message in Pumble, and skipping the delete then strands the marker
   * with no error. Pumble is the source of truth, the checkpoint already stops
   * repeat deletes, and removing a reaction that is not there is harmless.
   */
  private async removeStatusReaction(
    target: ResolvedTarget,
    state: CorrelationState,
    emoji: string,
    eventId: string,
    checkpoints: Set<string>,
  ): Promise<void> {
    const checkpoint = `reaction:remove:${emoji}`;
    if (!checkpoints.has(checkpoint) && (await this.safeRemoveReaction(target, emoji))) {
      await this.markCheckpoint(eventId, checkpoints, checkpoint);
    }
    state.activeReactions.delete(emoji);
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

  /**
   * Whether to post and edit an interim message for this conversation.
   *
   * Streaming suits a direct message, where the conversation is just the two
   * participants. In a channel the same behavior is a message mutating in
   * place while other people are talking, so it is off by default there.
   */
  private streamingEnabled(target: ResolvedTarget): boolean {
    const settings = this.settings?.get();
    if (!settings) return false;
    return target.direct === true
      ? settings.streamInDirectMessages
      : settings.streamInChannels;
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
