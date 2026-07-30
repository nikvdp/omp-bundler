/**
 * Deterministic per-conversation ingest buffer and activation state machine.
 *
 * The ingest buffer is the seam between an adapter's opaque conversation
 * stream and a single OMP RPC child. Adapters deliver {@link InboundMessage}
 * records one at a time; this module decides, for each arrival, whether the
 * agent should produce a turn now and in which OMP mode, or whether the
 * message should sit in an ambient backlog until the conversation is next
 * addressed.
 *
 * Identity and keying
 * -------------------
 * Adapter identity is route-scoped: the caller supplies `adapterId` (taken
 * from the route `/v1/adapters/{adapterId}/messages`) and the message carries
 * a raw, opaque `conversationKey`. Every internal store is keyed by the
 * composite tuple `(adapterId, conversationKey)` via {@link compositeKey},
 * which is collision-free for arbitrary opaque strings without ever parsing
 * or concatenating them unsafely. The buffer never inspects the content of
 * `conversationKey`; it is treated as a foreign key.
 *
 * Activation policy
 * -----------------
 * The buffer models a single engagement window per conversation. The window
 * opens when an addressed message activates it and stays open for
 * `engagementWindowMs` of wall-clock time, measured by an injected clock.
 *
 *   - Addressed arrival ALWAYS activates (or resets) the window, flushes the
 *     ambient backlog, and emits the backlog plus the current message as a
 *     single prompt decision.
 *   - Ambient arrival OUTSIDE the window is buffered as a discrete authored
 *     record and starts no turn.
 *   - Ambient arrival INSIDE the window resets the window and triggers a
 *     turn whose payload is the buffered backlog plus the current message.
 *   - Explicit {@link IngestBuffer.dismiss} immediately closes the window.
 *
 * OMP modes
 * ---------
 * The activation result carries an {@link ActivationMode} the caller maps
 * onto an OMP RPC interaction. This module never calls `RpcChild` and embeds
 * no platform detection; it only names the mode so the supervisor can choose
 * the right frame.
 *
 *   - Non-streaming activation chooses `"prompt"` for every triggering
 *     arrival (the standard `prompt` command).
 *   - Streaming activation chooses `"steer"` for an addressed arrival that
 *     interrupts an active stream, and `"followUp"` for an ambient arrival
 *     that continues one. These match the `streamingBehavior` values the OMP
 *     RPC child accepts (`"steer" | "followUp"`).
 *
 * The `"followUp"` literal here corresponds to the spec's `follow_up` concept
 * and is the exact OMP `streamingBehavior` enum value, so the supervisor can
 * forward it without translation.
 *
 * Determinism
 * -----------
 * The state machine is a pure function of (current state, message, clock
 * reading, streaming flag). There are no timers, no async, no background
 * sweeps: the window expires lazily, observed on the next arrival. Timestamps
 * on records are epoch milliseconds from the injected clock; outbound events
 * produced elsewhere carry UTC ISO 8601 strings ending in `Z`. This module
 * holds no secrets and performs no cryptographic work.
 */

import type { InboundMessage } from "@omp-bundler/contracts/inbound";
import type {
  Speaker,
  WorkspaceAttachment,
} from "@omp-bundler/contracts/shared";
import { conversationStorageKey } from "./adapter-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Constructor options. Both fields are required: no hidden defaults. */
export interface IngestBufferOptions {
  /**
   * Engagement window length in milliseconds. A positive, finite number. The
   * window is the duration for which an activated conversation stays engaged
   * after the last addressed or ambient-in-window arrival.
   */
  engagementWindowMs: number;
  /**
   * Injectable wall-clock returning epoch milliseconds. Used for window
   * deadlines and record timestamps so the state machine is deterministic
   * under tests.
   */
  now: () => number;
}

/**
 * Activation mode the supervisor maps onto an OMP RPC interaction.
 *
 * - `"prompt"`: non-streaming turn (the `prompt` command, no streaming
 *   behavior).
 * - `"steer"`: streaming addressed arrival (steer an active stream).
 * - `"followUp"`: streaming ambient arrival (continue an active stream).
 */
export type ActivationMode = "prompt" | "steer" | "followUp";

/**
 * A buffered authored record preserving full message identity. One record is
 * stored per arrival regardless of whether it activates; records are flushed
 * as a batch when a turn is triggered.
 */
export interface BufferedRecord {
  /** Route-scoped adapter id that owns the conversation. */
  adapterId: string;
  /** Opaque, adapter-scoped conversation key (foreign key, never interpreted). */
  conversationKey: string;
  /** Non-empty opaque message id within the adapter. */
  messageId: string;
  /** The party that produced the message, copied verbatim. */
  speaker: Speaker;
  /** Message text. May be empty for attachment-only messages. */
  text: string;
  /** Workspace-relative attachments, copied verbatim. */
  attachments: WorkspaceAttachment[];
  /** Whether the agent was directly invoked by this message. */
  addressed: boolean;
  /** Epoch millisecond timestamp from the injected clock at arrival. */
  receivedAt: number;
}

/** Result of {@link IngestBuffer.ingest}: the activation decision. */
export type IngestResult =
  | {
      /** The arrival was buffered and no turn was started. */
      kind: "buffered";
      /** The record stored for the buffered arrival. */
      record: BufferedRecord;
      /** Backlog depth for this conversation after buffering. */
      backlogDepth: number;
    }
  | {
      /** A turn was triggered and the backlog plus current message flushed. */
      kind: "activate";
      /** OMP mode the supervisor should use for this turn. */
      mode: ActivationMode;
      /** Records flushed as the turn payload, in arrival order. */
      records: BufferedRecord[];
      /** Records rendered as a single RPC prompt string. */
      prompt: string;
    };

/** Observable status of one conversation. */
export interface ConversationStatus {
  /** True when an unexpired engagement window is open. */
  active: boolean;
  /** Number of ambient records currently buffered. */
  backlogDepth: number;
  /** Epoch millisecond deadline of the window, or null when none is open. */
  windowDeadline: number | null;
}

// ---------------------------------------------------------------------------
// Composite key
// ---------------------------------------------------------------------------

/** Shared collision-proof key for `(adapterId, conversationKey)`. */
export const compositeKey = conversationStorageKey;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render one buffered record as text for an eventual RPC prompt, preserving
 * speaker identity (id and displayName) and attachment references. Deterministic:
 * the same record always renders to the same string.
 *
 * Format:
 *   <displayName> (id: <id>)
 *   <text>
 *   - <path> [name: <name>] [mediaType: <mediaType>]
 *
 * An empty text line is omitted (attachment-only messages). The `addressed`
 * flag is intentionally absent from the text; it survives on the record and is
 * expressed via the activation mode, not the prompt body.
 */
export function renderRecord(record: BufferedRecord): string {
  const lines: string[] = [
    `${record.speaker.displayName} (id: ${record.speaker.id})`,
  ];
  if (record.text.length > 0) lines.push(record.text);
  for (const attachment of record.attachments) {
    let line = `  - ${attachment.path}`;
    if (attachment.name) line += ` [name: ${attachment.name}]`;
    if (attachment.mediaType) line += ` [mediaType: ${attachment.mediaType}]`;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Render a batch of records as a single RPC prompt string, joining individual
 * records with a blank line separator. Identity is preserved per record; no
 * record is coalesced or dropped.
 */
export function renderPrompt(records: BufferedRecord[]): string {
  return records.map(renderRecord).join("\n\n");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ConversationState {
  /** Buffered ambient records awaiting the next activation, in arrival order. */
  backlog: BufferedRecord[];
  /** Epoch millisecond deadline of the open window, or null when closed. */
  windowDeadline: number | null;
}

// ---------------------------------------------------------------------------
// IngestBuffer
// ---------------------------------------------------------------------------

/**
 * Per-conversation ingest buffer and activation state machine over
 * {@link InboundMessage}. Single-instance, synchronous, deterministic. Hold
 * one instance for the whole supervisor; conversations are isolated by
 * composite key.
 */
export class IngestBuffer {
  private readonly engagementWindowMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, ConversationState>();

  /** Static alias of {@link compositeKey} for ergonomic access. */
  static readonly compositeKey = compositeKey;

  constructor(options: IngestBufferOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("IngestBufferOptions is required");
    }
    const { engagementWindowMs, now } = options;
    if (
      typeof engagementWindowMs !== "number" ||
      !Number.isFinite(engagementWindowMs) ||
      engagementWindowMs <= 0
    ) {
      throw new RangeError(
        "engagementWindowMs must be a positive, finite number of milliseconds",
      );
    }
    if (typeof now !== "function") {
      throw new TypeError("now clock function is required");
    }
    this.engagementWindowMs = engagementWindowMs;
    this.now = now;
  }

  /**
   * Ingest one inbound message and return the activation decision.
   *
   * @param adapterId Route-scoped adapter id (not present in the payload).
   * @param message The inbound message.
   * @param streaming Whether the conversation's OMP session is streaming, used
   *   only to select the activation mode for a triggered turn. Has no effect on
   *   buffering or window state.
   */
  ingest(
    adapterId: string,
    message: InboundMessage,
    streaming: boolean,
  ): IngestResult {
    const key = compositeKey(adapterId, message.conversationKey);
    const receivedAt = this.now();
    const record = toRecord(adapterId, message, receivedAt);
    const state = this.stateFor(key);

    if (message.addressed) {
      // Addressed: activate (or reset) the window and flush backlog plus
      // current message as a single prompt decision.
      state.windowDeadline = receivedAt + this.engagementWindowMs;
      const records = [...state.backlog, record];
      state.backlog = [];
      this.states.set(key, state);
      return {
        kind: "activate",
        mode: streaming ? "steer" : "prompt",
        records,
        prompt: renderPrompt(records),
      };
    }

    // Ambient.
    const active = isActive(state, receivedAt);
    if (active) {
      // Inside the window: reset the window and trigger a turn with the
      // current message plus any buffered backlog (backlog is normally empty
      // while engaged, but is flushed defensively and never lost).
      state.windowDeadline = receivedAt + this.engagementWindowMs;
      const records = [...state.backlog, record];
      state.backlog = [];
      this.states.set(key, state);
      return {
        kind: "activate",
        mode: streaming ? "followUp" : "prompt",
        records,
        prompt: renderPrompt(records),
      };
    }

    // Outside the window (no window open, or the window has expired). Prune a
    // lazily-expired deadline so introspection never reports a stale window,
    // then buffer as a discrete authored record and start no turn.
    state.windowDeadline = null;
    state.backlog.push(record);
    this.states.set(key, state);
    return { kind: "buffered", record, backlogDepth: state.backlog.length };
  }

  /**
   * Explicitly close the engagement window for a conversation immediately. The
   * ambient backlog is left untouched: dismissal closes the window only, it
   * does not discard buffered messages; the next addressed arrival flushes
   * them. Returns true only if an unexpired window was open and is now closed;
   * returns false when the conversation had no window or the window had
   * already expired (in that case the stale deadline is pruned to null).
   */
  dismiss(adapterId: string, conversationKey: string): boolean {
    const key = compositeKey(adapterId, conversationKey);
    const state = this.states.get(key);
    if (!state || state.windowDeadline === null) return false;
    const now = this.now();
    if (!isActive(state, now)) {
      // Expired but unpruned: clear the stale deadline so a later read never
      // observes a non-null, already-closed window.
      state.windowDeadline = null;
      this.states.set(key, state);
      return false;
    }
    state.windowDeadline = null;
    this.states.set(key, state);
    return true;
  }

  /**
   * Record an agent interaction to reset (extend) the engagement window while
   * a turn is in progress, keeping late-arriving ambient messages inside the
   * window so they trigger follow-ups rather than buffering. Has no effect when
   * the conversation is not currently engaged: the agent never self-activates.
   * Returns true if an active window was reset, false otherwise.
   */
  recordInteraction(adapterId: string, conversationKey: string): boolean {
    const key = compositeKey(adapterId, conversationKey);
    const state = this.states.get(key);
    if (!state) return false;
    const now = this.now();
    if (!isActive(state, now)) return false;
    state.windowDeadline = now + this.engagementWindowMs;
    this.states.set(key, state);
    return true;
  }

  /**
   * Inspect the observable state of one conversation. An expired deadline is
   * pruned and reported as `null` alongside `active: false`, never as a stale
   * `windowDeadline` with `active: false`; readers observe the invariant that
   * `windowDeadline` is null whenever `active` is false.
   */
  inspect(adapterId: string, conversationKey: string): ConversationStatus {
    const key = compositeKey(adapterId, conversationKey);
    const state = this.states.get(key);
    if (!state) return { active: false, backlogDepth: 0, windowDeadline: null };
    const now = this.now();
    const active = isActive(state, now);
    if (!active && state.windowDeadline !== null) {
      state.windowDeadline = null;
      this.states.set(key, state);
    }
    return {
      active,
      backlogDepth: state.backlog.length,
      windowDeadline: active ? state.windowDeadline : null,
    };
  }

  private stateFor(key: string): ConversationState {
    const existing = this.states.get(key);
    if (existing) return existing;
    return { backlog: [], windowDeadline: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isActive(state: ConversationState, now: number): boolean {
  return state.windowDeadline !== null && now < state.windowDeadline;
}

function toRecord(
  adapterId: string,
  message: InboundMessage,
  receivedAt: number,
): BufferedRecord {
  return {
    adapterId,
    conversationKey: message.conversationKey,
    messageId: message.messageId,
    speaker: {
      id: message.speaker.id,
      displayName: message.speaker.displayName,
    },
    text: message.text,
    attachments: message.attachments.map((a) => ({
      path: a.path,
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.mediaType !== undefined ? { mediaType: a.mediaType } : {}),
    })),
    addressed: message.addressed,
    receivedAt,
  };
}
