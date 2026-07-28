/**
 * Outbound webhook emitter for the omp-bundler core.
 *
 * Consumes generic RpcChild event frames for a single adapter correlation
 * (adapterId + conversationKey + correlationId), maps them to the outbound
 * v1 webhook contract, persists durable events to a SQLite outbox BEFORE
 * attempting HTTP delivery, signs the exact JSON body via a per-adapter
 * signing closure (the shared secret never leaves the adapter registry), and
 * retries network/non-2xx failures using an explicit delay schedule.
 * Permanent failures are retained and surfaced. After a restart,
 * {@link OutboundEmitter.resumePending} re-drives every durable event that
 * never reached a 2xx ack.
 *
 * Delivery ordering
 * ----------------
 * All HTTP POSTs (durable and best-effort) are serialized onto a single
 * per-emitter promise chain ({@link deliveryChain}). Durable rows are
 * persisted synchronously BEFORE their POST is enqueued, so the outbox
 * always reflects the intended sequence even if the process dies mid-delivery.
 * The chain guarantees per-correlation sequence ordering: a failed or
 * permanently-failed event settles (its DeliveryPromise resolves) before the
 * next event's POST begins. {@link resumePending} shares the same chain so it
 * cannot race a queued live delivery.
 *
 * Frame mapping
 * -------------
 *   turn_start          -> turn.started (durable, first event for a turn)
 *   message_update      -> text deltas accumulate into the eventual reply;
 *                          streamed deltas are progress candidates
 *   subagent_*          -> progress candidates
 *   turn_end            -> usage/cost collected (NO terminal reply here)
 *   agent_end           -> exactly ONE terminal turn.reply (durable)
 *   provider/child error-> exactly ONE terminal turn.error (durable)
 *
 * Terminal events are emitted exactly once per correlation: turn.reply at
 * agent_end (not at each internal turn_end), and one curated turn.error for a
 * provider/child failure. Progress is best-effort and unpersisted: it is
 * emitted only after {@link progressThresholdMs} of wall time has elapsed
 * since the last emitted progress, and consecutive candidates are coalesced so
 * at most one progress event per threshold window is delivered.
 *
 * Sequence is monotonic per correlationId and persisted with durable events.
 * Progress events share the same monotonic counter but are never persisted,
 * so a dropped progress event creates a sequence gap the adapter MUST tolerate
 * (per contract).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";

import type {
  OutboundEvent,
  Presence,
  TurnErrorEvent,
  TurnProgressEvent,
  TurnReplyEvent,
  TurnStartedEvent,
  TurnUsage,
  PresenceChangedEvent,
} from "@omp-bundler/contracts/outbound";
import {
  ADAPTER_API_VERSION,
  OUTBOUND_EVENT_CONTENT_TYPE_HEADER,
  OUTBOUND_EVENT_MEDIA_TYPE,
  OUTBOUND_EVENT_SIGNATURE_HEADER,
  OUTBOUND_EVENT_TYPE_HEADER,
} from "@omp-bundler/contracts/outbound";
import type { RpcEventFrame } from "./rpc-child.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolved callback target for an adapter. The secret never crosses this
 * boundary: {@link sign} is a closure the supervisor builds over the
 * adapter-registry signing key, so the emitter never sees the raw secret.
 */
export interface AdapterTarget {
  /** Absolute callback URL the core POSTs outbound events to. */
  callbackUrl: string;
  /**
   * Compute the outbound signature header value for the exact UTF-8 body.
   * The returned string is placed verbatim in the
   * `X-OMP-Bundler-Signature` header.
   */
  sign(body: string): string;
}

/** Function the emitter calls to resolve the callback target for an adapter. */
export type AdapterTargetResolver = (adapterId: string) => AdapterTarget | null;

/** Injectable clock returning the current time in epoch milliseconds. */
export type Clock = () => number;

/** Injectable UUID generator. */
export type UuidFactory = () => string;

/** Minimal structured logger the emitter writes to. */
export interface EmitterLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * Optional synchronous lifecycle hooks invoked by the emitter around durable
 * delivery. All are no-ops by default (a non-operational dependency). Each
 * may throw to abort its phase; see the option docstrings for semantics.
 */
export interface DurableLifecycleHooks {
  /**
   * Called BEFORE a durable event is inserted into the outbox or POSTed. If
   * it throws, the event is NOT persisted and NOT POSTed, and the rejection is
   * surfaced on the per-emitter delivery chain (observable via {@link flush}).
   * The supervisor uses this to e.g. save a terminal response in an
   * {@link IdempotencyStore} before committing to delivery.
   */
  onDurablePrepared?(event: OutboundEvent): void;
  /**
   * Called AFTER a durable event reaches a 2xx ack and the outbox row is
   * marked delivered. The supervisor uses this to e.g. markSent.
   */
  onDurableDelivered?(event: OutboundEvent): void;
  /**
   * Called AFTER a durable event is retained as a permanent failure (retry
   * schedule exhausted without an ack). The supervisor uses this to e.g.
   * markFailed. Receives the last error string.
   */
  onDurableFailed?(event: OutboundEvent, error: string): void;
}

/** Options for constructing an {@link OutboundEmitter}. */
export interface OutboundEmitterOptions {
  /** Adapter identity (route-scoped). Never appears inside event payloads. */
  adapterId: string;
  /** Opaque conversation key carried raw from the inbound payload. */
  conversationKey: string;
  /** Correlation id scoping the sequence counter for this turn. */
  correlationId: string;
  /** Resolves the adapter callback target (URL + signing closure). */
  resolveAdapterTarget: AdapterTargetResolver;
  /** HTTP fetch implementation injected by the caller. */
  fetchImpl: typeof fetch;
  /**
   * Filesystem path to the SQLite outbox database. Parent directories are
   * created if missing. Required; no hidden operational default. Use
   * `:memory:` for ephemeral, in-memory registries (testing only).
   */
  dbPath: string;
  /**
   * Minimum wall-time gap (ms) between emitted progress events. Progress
   * candidates arriving within the window are coalesced; only the latest
   * candidate after the window elapses is delivered. Required and nonnegative.
   */
  progressThresholdMs: number;
  /**
   * Explicit, ordered retry delay schedule in ms. Each entry is the delay
   * before the corresponding retry attempt. After the last delay is consumed
   * without an ack, the event is retained as a permanent failure. Required.
   * No hidden operational defaults: an empty array means no retries. Every
   * entry must be a nonnegative finite number.
   */
  retryDelaysMs: readonly number[];
  /**
   * Timeout in ms applied to every outbound HTTP POST via
   * `AbortSignal.timeout`. Required and positive finite so bounded retries are
   * actually bounded. A timed-out POST is treated as a network error and
   * retried per {@link retryDelaysMs}.
   */
  requestTimeoutMs: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: Clock;
  /** Injectable UUID generator. Defaults to `randomUUID`. */
  uuid?: UuidFactory;
  /** Injectable logger. Defaults to a no-op logger. */
  logger?: EmitterLogger;
  /** Optional durable lifecycle hooks (no-ops by default). */
  hooks?: DurableLifecycleHooks;
}

/** Status of a durable outbox row. */
export type OutboxStatus = "pending" | "delivered" | "permanent_failure";

/** A persisted durable event row. */
export interface OutboxRow {
  eventId: string;
  adapterId: string;
  conversationKey: string;
  correlationId: string;
  sequence: number;
  eventType: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound_outbox (
  event_id        TEXT    NOT NULL PRIMARY KEY,
  adapter_id      TEXT    NOT NULL,
  conversation_key TEXT   NOT NULL,
  correlation_id  TEXT    NOT NULL,
  sequence        INTEGER NOT NULL,
  event_type      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
`;

const INDEX_PENDING = `
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbound_outbox (adapter_id, correlation_id, status);
`;

const INDEX_SEQUENCE = `
CREATE INDEX IF NOT EXISTS idx_outbox_sequence
  ON outbound_outbox (adapter_id, correlation_id, sequence);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current time as a UTC ISO 8601 string (always Z-suffixed). */
function nowUtc(): string {
  return new Date().toISOString();
}

/** Format an epoch millisecond timestamp as a UTC ISO 8601 string ending in Z. */
function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Coerce a possibly-unknown numeric value to a nonnegative integer. */
function nonnegInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Coerce a possibly-unknown numeric value to a nonnegative number. */
function nonnegNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// OutboundEmitter
// ---------------------------------------------------------------------------

/**
 * Emitter for one adapter correlation. One instance owns the frame-to-event
 * mapping, the SQLite outbox, and the HTTP delivery loop for a single
 * (adapterId, conversationKey, correlationId) triple.
 */
export class OutboundEmitter {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private closed = false;
  private readonly opts: {
    adapterId: string;
    conversationKey: string;
    correlationId: string;
    resolveAdapterTarget: AdapterTargetResolver;
    fetchImpl: typeof fetch;
    retryDelaysMs: readonly number[];
    progressThresholdMs: number;
    requestTimeoutMs: number;
    now: Clock;
    uuid: UuidFactory;
    logger: EmitterLogger;
    hooks: DurableLifecycleHooks;
  };

  /** Monotonic per-correlation sequence counter (persisted with durable rows). */
  private sequence = 0;

  /** Accumulated reply text from message_update text deltas. */
  private replyText = "";

  /** Accumulated usage/cost from turn_end. */
  private replyUsage: TurnUsage | null = null;

  /** Whether a terminal event (turn.reply or turn.error) has been emitted. */
  private terminalEmitted = false;

  /** Whether turn.started has been emitted for this correlation. */
  private startedEmitted = false;

  /** Timestamp (epoch ms) of the last emitted progress event. */
  private lastProgressAt = 0;

  /** Coalesced pending progress candidate message, or null when none pending. */
  private pendingProgress: string | null = null;

  /**
   * Per-emitter promise chain serializing ALL HTTP POSTs (durable and
   * best-effort). Each enqueue appends to the tail; failures settle before the
   * next POST begins, preserving per-correlation sequence ordering. Both live
   * delivery and {@link resumePending} share this chain so they never race.
   */
  private deliveryChain: Promise<void> = Promise.resolve();

  constructor(options: OutboundEmitterOptions) {
    if (!options.adapterId) throw new Error("adapterId is required");
    if (!options.conversationKey) throw new Error("conversationKey is required");
    if (!options.correlationId) throw new Error("correlationId is required");
    if (!options.resolveAdapterTarget) {
      throw new Error("resolveAdapterTarget is required");
    }
    if (!options.fetchImpl) throw new Error("fetchImpl is required");
    if (!options.dbPath) throw new Error("dbPath is required");
    if (
      !Number.isFinite(options.progressThresholdMs) ||
      options.progressThresholdMs < 0
    ) {
      throw new Error("progressThresholdMs must be a nonnegative finite number");
    }
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new Error("requestTimeoutMs must be a positive finite number");
    }
    if (!Array.isArray(options.retryDelaysMs)) {
      throw new Error("retryDelaysMs must be an array");
    }
    for (const d of options.retryDelaysMs) {
      if (!Number.isFinite(d) || d < 0) {
        throw new Error("retryDelaysMs entries must be nonnegative finite numbers");
      }
    }

    this.opts = {
      adapterId: options.adapterId,
      conversationKey: options.conversationKey,
      correlationId: options.correlationId,
      resolveAdapterTarget: options.resolveAdapterTarget,
      fetchImpl: options.fetchImpl,
      retryDelaysMs: options.retryDelaysMs,
      progressThresholdMs: options.progressThresholdMs,
      requestTimeoutMs: options.requestTimeoutMs,
      now: options.now ?? Date.now,
      uuid: options.uuid ?? (() => randomUUID()),
      logger: options.logger ?? noopLogger,
      hooks: options.hooks ?? {},
    };

    if (options.dbPath !== ":memory:") {
      const slash = options.dbPath.lastIndexOf("/");
      const dir = slash > 0 ? options.dbPath.substring(0, slash) : "";
      if (dir) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.dbPath);
    this.ownsDb = true;
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(SCHEMA);
    this.db.run(INDEX_PENDING);
    this.db.run(INDEX_SEQUENCE);

    // Resume the monotonic sequence from the highest persisted sequence for
    // this correlation so events emitted after resume continue monotonically.
    const maxSeq = this.db
      .query(
        `SELECT MAX(sequence) AS max_seq FROM outbound_outbox
          WHERE adapter_id = ? AND correlation_id = ?`,
      )
      .get(this.opts.adapterId, this.opts.correlationId) as
      | { max_seq: number | null }
      | undefined;
    if (maxSeq?.max_seq != null) {
      this.sequence = maxSeq.max_seq;
    }

    const terminalRow = this.db
      .query(
        `SELECT event_id, event_type FROM outbound_outbox
          WHERE adapter_id = ? AND correlation_id = ?
            AND event_type IN ('turn.reply', 'turn.error')
          LIMIT 1`,
      )
      .get(this.opts.adapterId, this.opts.correlationId) as
      | { event_id: string; event_type: string }
      | undefined;
    if (terminalRow) {
      // A terminal event already exists (pending or delivered). Guard against
      // re-emitting a duplicate terminal on any post-restart re-ingestion; the
      // pending row is re-driven by resumePending().
      this.terminalEmitted = true;
      this.startedEmitted = true;
    }
  }

  // ---- public API ----

  /**
   * Ingest a generic RpcChild event frame for this correlation. Maps the frame
   * to one or more outbound events and drives durable delivery. Durable rows
   * are persisted synchronously before their POST is enqueued on the delivery
   * chain. Idempotent against duplicate frame ingestion within a process:
   * accumulating frames twice does not double-emit terminals because the
   * terminal guard is process-local. Durable dedupe is keyed on eventId at
   * the adapter.
   */
  ingest(frame: RpcEventFrame): void {
    switch (frame.type) {
      case "turn_start":
        this.handleTurnStart();
        break;
      case "message_update":
        this.handleMessageUpdate(frame);
        break;
      case "turn_end":
        this.handleTurnEnd(frame);
        break;
      case "agent_end":
        this.handleAgentEnd(frame);
        break;
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
        this.handleProgressCandidate(this.describeSubagentFrame(frame));
        break;
      case "message_end":
        // No outbound mapping; ignored.
        break;
      case "message_start":
        // No outbound mapping; ignored.
        break;
      default:
        // Unknown frame: ignore silently. The emitter only maps frames it knows.
        break;
    }
  }

  /**
   * Emit a terminal curated error for a provider/child failure. Produces
   * exactly one turn.error event for the correlation. No-op if a terminal
   * event was already emitted.
   */
  emitProviderError(error: { code: string; message: string; retryable: boolean }): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.ensureStarted();
    const event: TurnErrorEvent = {
      version: ADAPTER_API_VERSION,
      type: "turn.error",
      eventId: this.opts.uuid(),
      conversationKey: this.opts.conversationKey,
      correlationId: this.opts.correlationId,
      sequence: this.nextSequence(),
      occurredAt: toIsoUtc(this.opts.now()),
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    this.deliverDurable(event);
  }

  /**
   * Emit a presence.changed event for the conversation. Durable.
   */
  emitPresence(presence: Presence): void {
    const event: PresenceChangedEvent = {
      version: ADAPTER_API_VERSION,
      type: "presence.changed",
      eventId: this.opts.uuid(),
      conversationKey: this.opts.conversationKey,
      correlationId: this.opts.correlationId,
      sequence: this.nextSequence(),
      occurredAt: toIsoUtc(this.opts.now()),
      presence,
    };
    this.deliverDurable(event);
  }

  /**
   * Flush any coalesced progress candidate whose threshold window has elapsed.
   * Called opportunistically; also safe to call directly.
   */
  flushProgress(): void {
    if (this.pendingProgress === null) return;
    const elapsed = this.opts.now() - this.lastProgressAt;
    if (elapsed >= this.opts.progressThresholdMs) {
      const message = this.pendingProgress;
      this.pendingProgress = null;
      this.emitProgress(message);
    }
  }

  /**
   * After a restart, re-drive every durable event still marked pending. Each
   * resumed row re-enters the retry/ack loop continuing from its persisted
   * attempt count. Deliveries are enqueued onto the shared {@link deliveryChain}
   * in sequence order so they neither race live delivery nor reorder events.
   * Permanent failures are NOT retried (their retry schedule was already
   * exhausted); they are surfaced via {@link permanentFailures}.
   */
  async resumePending(): Promise<void> {
    const rows = this.db
      .query(
        `SELECT payload, attempts FROM outbound_outbox
          WHERE adapter_id = ? AND correlation_id = ? AND status = 'pending'
          ORDER BY sequence ASC`,
      )
      .all(this.opts.adapterId, this.opts.correlationId) as {
        payload: string;
        attempts: number;
      }[];

    // Parse each persisted payload back into a concrete OutboundEvent so the
    // durable hooks (onDurableDelivered/onDurableFailed) receive a real event
    // object on resume, not a row id. Enqueue onto the shared deliveryChain so
    // resumed deliveries neither race live ones nor reorder events.
    const tails: Promise<void>[] = [];
    for (const row of rows) {
      const event = JSON.parse(row.payload) as OutboundEvent;
      tails.push(
        this.enqueue(() =>
          this.deliverPayload(event, row.payload, row.attempts),
        ),
      );
    }
    await Promise.all(tails);
  }

  /** Await all queued HTTP deliveries (the per-emitter delivery chain). */
  async flush(): Promise<void> {
    await this.deliveryChain;
  }

  /** Durable outbox rows for this correlation matching the given status. */
  outboxByStatus(status: OutboxStatus): OutboxRow[] {
    const rows = this.db
      .query(
        `SELECT event_id, adapter_id, conversation_key, correlation_id,
                sequence, event_type, payload, status, attempts, last_error,
                created_at, updated_at
           FROM outbound_outbox
          WHERE adapter_id = ? AND correlation_id = ? AND status = ?
          ORDER BY sequence ASC`,
      )
      .all(this.opts.adapterId, this.opts.correlationId, status) as Record<
        string,
        unknown
      >[];
    return rows.map(rowToOutboxRow);
  }

  /** All permanent failures for this correlation (retained, surfaced). */
  permanentFailures(): OutboxRow[] {
    return this.outboxByStatus("permanent_failure");
  }

  /** Close the underlying database handle. Genuinely idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) {
      this.db.close();
    }
  }

  // ---- frame handlers ----

  /** turn_start -> turn.started (durable, first event). Seeds the progress baseline. */
  private handleTurnStart(): void {
    if (this.startedEmitted) return;
    this.startedEmitted = true;
    const now = this.opts.now();
    // Seed the progress baseline so the first progress candidate must wait
    // the full threshold window before being emitted (only-after-threshold).
    this.lastProgressAt = now;
    const event: TurnStartedEvent = {
      version: ADAPTER_API_VERSION,
      type: "turn.started",
      eventId: this.opts.uuid(),
      conversationKey: this.opts.conversationKey,
      correlationId: this.opts.correlationId,
      sequence: this.nextSequence(),
      occurredAt: toIsoUtc(now),
    };
    this.deliverDurable(event);
  }

  /**
   * message_update -> accumulate text deltas; each delta is a progress
   * candidate.
   */
  private handleMessageUpdate(frame: RpcEventFrame): void {
    const delta = extractTextDelta(frame);
    if (delta !== null && delta.length > 0) {
      this.replyText += delta;
      this.handleProgressCandidate(delta);
    }
  }

  /** turn_end -> collect usage/cost from the assistant message. NO reply here. */
  private handleTurnEnd(frame: RpcEventFrame): void {
    const usage = extractUsage(frame);
    if (usage) {
      this.replyUsage = usage;
    }
  }

  /** agent_end -> exactly ONE terminal turn.reply (durable). */
  private handleAgentEnd(frame: RpcEventFrame): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.ensureStarted();

    // Prefer usage accumulated from turn_end; fall back to agent_end messages.
    let usage = this.replyUsage ?? null;
    if (!usage) {
      usage = extractUsageFromAgentEnd(frame);
    }

    const event: TurnReplyEvent = {
      version: ADAPTER_API_VERSION,
      type: "turn.reply",
      eventId: this.opts.uuid(),
      conversationKey: this.opts.conversationKey,
      correlationId: this.opts.correlationId,
      sequence: this.nextSequence(),
      occurredAt: toIsoUtc(this.opts.now()),
      text: this.replyText,
      attachments: [],
      usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    };
    this.deliverDurable(event);
  }

  /**
   * Progress candidate: coalesce into the pending slot and emit only after the
   * threshold window has elapsed since the last emitted progress.
   */
  private handleProgressCandidate(message: string): void {
    this.pendingProgress = message;
    this.flushProgress();
  }

  // ---- internal helpers ----

  private ensureStarted(): void {
    if (!this.startedEmitted) {
      this.startedEmitted = true;
      const now = this.opts.now();
      this.lastProgressAt = now;
      const event: TurnStartedEvent = {
        version: ADAPTER_API_VERSION,
        type: "turn.started",
        eventId: this.opts.uuid(),
        conversationKey: this.opts.conversationKey,
        correlationId: this.opts.correlationId,
        sequence: this.nextSequence(),
        occurredAt: toIsoUtc(now),
      };
      this.deliverDurable(event);
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** Emit a best-effort, unpersisted progress event. */
  private emitProgress(message: string): void {
    this.lastProgressAt = this.opts.now();
    const event: TurnProgressEvent = {
      version: ADAPTER_API_VERSION,
      type: "turn.progress",
      eventId: this.opts.uuid(),
      conversationKey: this.opts.conversationKey,
      correlationId: this.opts.correlationId,
      sequence: this.nextSequence(),
      occurredAt: toIsoUtc(this.opts.now()),
      message,
    };
    this.deliverBestEffort(event);
  }

  private describeSubagentFrame(frame: RpcEventFrame): string {
    const label =
      frame.type === "subagent_lifecycle"
        ? "subagent lifecycle"
        : frame.type === "subagent_progress"
          ? "subagent progress"
          : "subagent event";
    const id = typeof frame.id === "string" ? frame.id : "";
    const name = typeof (frame as { name?: unknown }).name === "string"
      ? (frame as { name?: string }).name
      : "";
    const detail = name ? `${name}` : id ? id : "";
    return detail ? `${label}: ${detail}` : label;
  }

  /**
   * Append a POST operation onto the per-emitter {@link deliveryChain}. The
   * operation runs only after all prior deliveries settle (success or
   * failure), so per-correlation sequence ordering is preserved and a failed
   * event cannot starve the next. Returns the tail promise for callers that
   * need to await a specific enqueue (e.g. {@link resumePending}).
   */
  private enqueue(post: () => Promise<void>): Promise<void> {
    // Chain with the same handler on both fulfill and reject branches so a
    // prior rejection never blocks the next delivery.
    const next = this.deliveryChain.then(post, post);
    this.deliveryChain = next;
    return next;
  }

  // ---- durable delivery ----

  /**
   * Persist a durable event to the outbox synchronously BEFORE enqueueing its
   * POST onto the delivery chain. The {@link onDurablePrepared} hook is called
   * BEFORE the insert; if it throws, the event is NOT persisted and NOT POSTed,
   * and the rejection is enqueued onto the delivery chain so it remains
   * observable via {@link flush}. If an equal eventId already exists with
   * identical content (idempotent replay), the insert is skipped. If an equal
   * eventId exists with differing content, a {@link DuplicateEventConflictError}
   * is thrown. The POST is never started before the row is durably persisted.
   */
  private deliverDurable(event: OutboundEvent): void {
    const payload = JSON.stringify(event);
    const occurredAt = event.occurredAt;

    // prepared hook runs before any persistence or HTTP. A throw aborts the
    // whole event; the rejection is surfaced on the delivery chain so flush()
    // observes it rather than silently swallowing the failure.
    try {
      this.opts.hooks.onDurablePrepared?.(event);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      this.enqueue(() => Promise.reject(failure));
      return;
    }

    const inserted = this.persistEvent(
      event.eventId,
      event.sequence,
      event.type,
      payload,
      occurredAt,
    );
    if (!inserted) return; // idempotent duplicate eventId already persisted
    this.enqueue(() =>
      this.deliverPayload(event, payload, 0),
    );
  }

  /**
   * Insert one durable row. Returns true when inserted, false when the eventId
   * already exists with identical content (idempotent replay). Throws
   * {@link DuplicateEventConflictError} when an eventId exists with differing
   * content. Non-unique, non-conflict DB errors propagate unchanged.
   */
  private persistEvent(
    eventId: string,
    sequence: number,
    eventType: string,
    payload: string,
    occurredAt: string,
  ): boolean {
    try {
      this.db.run(
        `INSERT OR FAIL INTO outbound_outbox
           (event_id, adapter_id, conversation_key, correlation_id,
            sequence, event_type, payload, status, attempts, last_error,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        [
          eventId,
          this.opts.adapterId,
          this.opts.conversationKey,
          this.opts.correlationId,
          sequence,
          eventType,
          payload,
          occurredAt,
          occurredAt,
        ],
      );
      return true;
    } catch (err) {
      // The insert failed. Read the row keyed on eventId to classify the
      // failure. An exact full-row match is an idempotent replay (return false).
      // A row with differing content is a genuine conflict. If NO row exists
      // for this eventId, the failure was NOT a duplicate at all (disk full,
      // locked, etc.) and the original DB error is rethrown unchanged so it
      // cannot masquerade as a duplicate.
      const existing = this.db
        .query(
          `SELECT adapter_id, conversation_key, correlation_id,
                  sequence, event_type, payload, created_at
             FROM outbound_outbox
            WHERE event_id = ?`,
        )
        .get(eventId) as Record<string, unknown> | undefined;

      if (!existing) {
        throw err;
      }
      if (
        existing.adapter_id === this.opts.adapterId &&
        existing.conversation_key === this.opts.conversationKey &&
        existing.correlation_id === this.opts.correlationId &&
        Number(existing.sequence) === sequence &&
        existing.event_type === eventType &&
        existing.payload === payload &&
        existing.created_at === occurredAt
      ) {
        return false; // exact immutable-row idempotent replay
      }
      throw new DuplicateEventConflictError(eventId, err);
    }
  }
  /**
   * Deliver a persisted durable payload with retry. 2xx marks the row
   * 'delivered' and fires {@link onDurableDelivered}. Network errors and
   * non-2xx responses are retried using the explicit {@link retryDelaysMs}
   * schedule. After the schedule is exhausted without an ack, the row is
   * retained as 'permanent_failure' with lastError and {@link onDurableFailed}
   * fires. {@link event} is the parsed outbound event carried through the retry
   * and resume path so hooks receive a concrete event object.
   *
   * The schedule is: one immediate initial POST, then one retry per entry in
   * {@link retryDelaysMs}, each preceded by its delay. So a schedule of
   * `[d0, d1]` yields up to three POSTs: immediate, d0-retry, d1-retry. On
   * resume, {@link startingAttempts} is the count of POST attempts already
   * made, so the loop continues the schedule mid-flight with no doubled delay.
   */
  private async deliverPayload(
    event: OutboundEvent,
    payload: string,
    startingAttempts: number,
  ): Promise<void> {
    const target = this.opts.resolveAdapterTarget(this.opts.adapterId);
    if (!target) {
      const msg = `no adapter target registered for "${this.opts.adapterId}"`;
      this.markPermanentFailure(event.eventId, msg);
      this.opts.hooks.onDurableFailed?.(event, msg);
      return;
    }

    const totalPosts = 1 + this.opts.retryDelaysMs.length;
    let lastError = "";

    for (let attempt = startingAttempts; attempt < totalPosts; attempt++) {
      if (attempt > 0) {
        const delay = this.opts.retryDelaysMs[attempt - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }

      try {
        const { ok, status } = await this.postOnce(
          target.callbackUrl,
          target.sign,
          payload,
          event.type,
        );
        if (ok) {
          this.markDelivered(event.eventId, attempt + 1);
          this.opts.hooks.onDurableDelivered?.(event);
          return;
        }
        lastError = `adapter ${target.callbackUrl} responded ${status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      this.recordAttempt(event.eventId, attempt + 1, lastError);
    }

    // Schedule exhausted without an ack: permanent failure, retained.
    this.markPermanentFailure(event.eventId, lastError);
    this.opts.hooks.onDurableFailed?.(event, lastError);
  }

  /**
   * One POST attempt. Returns the HTTP status alongside the ack verdict so the
   * caller can surface the real status in {@link markPermanentFailure}.
   * Throws on network/transport error or request timeout (so the caller can
   * retry). Every fetch is bounded by {@link requestTimeoutMs} via
   * `AbortSignal.timeout`.
   */
  private async postOnce(
    callbackUrl: string,
    sign: (body: string) => string,
    body: string,
    eventType: string,
  ): Promise<{ ok: boolean; status: number }> {
    const signature = sign(body);
    const headers: Record<string, string> = {
      [OUTBOUND_EVENT_CONTENT_TYPE_HEADER]: OUTBOUND_EVENT_MEDIA_TYPE,
      [OUTBOUND_EVENT_SIGNATURE_HEADER]: signature,
      [OUTBOUND_EVENT_TYPE_HEADER]: eventType,
    };
    const res = await this.opts.fetchImpl(callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  }

  private markDelivered(eventId: string, attempts: number): void {
    const ts = nowUtc();
    this.db.run(
      `UPDATE outbound_outbox
          SET status = 'delivered', attempts = ?, last_error = NULL, updated_at = ?
        WHERE event_id = ?`,
      [attempts, ts, eventId],
    );
  }

  private recordAttempt(eventId: string, attempts: number, error: string): void {
    const ts = nowUtc();
    this.db.run(
      `UPDATE outbound_outbox
          SET attempts = ?, last_error = ?, updated_at = ?
        WHERE event_id = ?`,
      [attempts, error, ts, eventId],
    );
  }

  private markPermanentFailure(eventId: string, error: string): void {
    const ts = nowUtc();
    this.db.run(
      `UPDATE outbound_outbox
          SET status = 'permanent_failure', last_error = ?, updated_at = ?
        WHERE event_id = ?`,
      [error, ts, eventId],
    );
    this.opts.logger.error("outbound event permanently failed", {
      eventId,
      adapterId: this.opts.adapterId,
      correlationId: this.opts.correlationId,
      error,
    });
  }

  // ---- best-effort delivery ----

  /** Enqueue a single unpersisted POST for a progress event (no retry). */
  private deliverBestEffort(event: OutboundEvent): void {
    this.enqueue(() => this.postBestEffort(event));
  }

  /**
   * One best-effort POST for a progress event. No persistence, no retry. A
   * non-2xx or network error is logged and the progress event is simply
   * dropped; the adapter tolerates the resulting sequence gap.
   */
  private async postBestEffort(event: OutboundEvent): Promise<void> {
    const target = this.opts.resolveAdapterTarget(this.opts.adapterId);
    if (!target) return;
    const body = JSON.stringify(event);
    try {
      const { ok, status } = await this.postOnce(
        target.callbackUrl,
        target.sign,
        body,
        event.type,
      );
      if (!ok) {
        this.opts.logger.warn("best-effort progress delivery non-2xx", {
          eventId: event.eventId,
          adapterId: this.opts.adapterId,
          status,
        });
      }
    } catch (err) {
      this.opts.logger.warn("best-effort progress delivery failed", {
        eventId: event.eventId,
        adapterId: this.opts.adapterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link OutboundEmitter} when a durable insert collides on an
 * existing `eventId` whose persisted content (adapter, conversation, sequence,
 * type, or payload) differs from the insert being attempted. An exact content
 * match is treated as an idempotent replay and does NOT throw.
 */
export class DuplicateEventConflictError extends Error {
  readonly eventId: string;
  readonly cause: unknown;

  constructor(eventId: string, cause: unknown) {
    super(`outbox eventId "${eventId}" already exists with conflicting content`);
    this.name = "DuplicateEventConflictError";
    this.eventId = eventId;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Frame extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text delta from a message_update frame. The frame carries an
 * `assistantMessageEvent` whose `text_delta` variant has a `delta` string.
 * Returns null when the frame is not a text delta.
 */
function extractTextDelta(frame: RpcEventFrame): string | null {
  const ev = (frame as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  if (!ev || typeof ev !== "object") return null;
  const type = (ev as { type?: unknown }).type;
  if (type !== "text_delta") return null;
  const delta = (ev as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : null;
}

/**
 * Extract usage/cost from a turn_end frame. The turn_end frame carries the
 * completed assistant `message` whose `usage` field holds token counts and a
 * `cost` object. Returns null when no usable usage is present.
 */
function extractUsage(frame: RpcEventFrame): TurnUsage | null {
  const message = (frame as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  return usageFromMessage(message as Record<string, unknown>);
}

/** Extract usage from the agent_end message list (first assistant message). */
function extractUsageFromAgentEnd(frame: RpcEventFrame): TurnUsage {
  const messages = (frame as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const u = usageFromMessage(msg as Record<string, unknown>);
      if (u) return u;
    }
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

/**
 * Map a provider assistant message's Usage object to the outbound TurnUsage
 * contract shape. All counts coerce to nonnegative integers; cost is the
 * provider-reported `cost.total` in USD.
 */
function usageFromMessage(msg: Record<string, unknown>): TurnUsage | null {
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const cost = u.cost;
  return {
    input: nonnegInt(u.input),
    output: nonnegInt(u.output),
    cacheRead: nonnegInt(u.cacheRead),
    cacheWrite: nonnegInt(u.cacheWrite),
    costUsd: cost && typeof cost === "object"
      ? nonnegNum((cost as Record<string, unknown>).total)
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

const noopLogger: EmitterLogger = {
  warn() {},
  error() {},
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function rowToOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    eventId: String(row.event_id),
    adapterId: String(row.adapter_id),
    conversationKey: String(row.conversation_key),
    correlationId: String(row.correlation_id),
    sequence: Number(row.sequence),
    eventType: String(row.event_type),
    payload: String(row.payload),
    status: String(row.status) as OutboxStatus,
    attempts: Number(row.attempts),
    lastError: row.last_error === null || row.last_error === undefined
      ? null
      : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}