/**
 * SQLite-backed idempotency store for inbound adapter messages.
 *
 * The deduplication key is the pair (adapterId, messageId). Each row records
 * the core-generated correlation id (opaque and stable for every replay of
 * the same key), a SHA-256 over the canonicalized inbound message, and two
 * independent state tracks:
 *
 * - ingest state:  pending -> completed
 *   Tracks whether the inbound ingestion and any agent turn it triggers are
 *   still in flight.
 *
 * - delivery state: pending -> saved -> sent
 *                 saved -> failed -> sent
 *   Tracks the outbound side independently. A completed terminal event
 *   (a `turn.reply`, or a `turn.error` that IS the model's terminal output)
 *   is saved to the row BEFORE delivery so a crash after save but before
 *   the adapter ack reopens to a redeliverable response without a second
 *   agent turn. Delivery failure (`saved -> failed`) RETAINS the saved
 *   response so a retry redelivers the same expensive payload; only
 *   `markSent` clears the need to redeliver (terminal `sent`).
 *
 * Race safety: every mutation uses a compare-and-set UPDATE guarded by a
 * WHERE clause on the expected prior state; the affected row count is
 * verified, so two concurrent transitions never silently overwrite each
 * other. {@link IdempotencyStore.beginInbound} runs its insert-or-classify
 * inside a single transaction so a brand-new correlation id is committed
 * atomically with the canonical payload hash.
 *
 * Canonicalization: the inbound message is canonicalized by recursively
 * sorting object keys (arrays keep element order but recurse into
 * elements) and SHA-256-ing the resulting JSON text. Two messages that
 * differ only in JSON property order therefore replay identically. The
 * same key plus a different canonical payload is a conflict and throws
 * {@link IdempotencyConflictError}; the original row is never mutated.
 *
 * Lifecycle:
 * - {@link IdempotencyStore.beginInbound} creates a correlation id or
 *   returns a typed existing result (already-sent, response-saved,
 *   delivery-failed, or pending).
 * - {@link IdempotencyStore.markIngestComplete} advances ingest state.
 * - {@link IdempotencyStore.saveResponse} stores the terminal event before
 *   delivery (ingest must be complete, delivery pending). Accepts only
 *   terminal `turn.reply` or `turn.error` events whose correlationId and
 *   conversationKey match the stored row, so a model/turn error IS a saved
 *   `turn.error` event, never a `markFailed` from the pending state.
 * - {@link IdempotencyStore.markFailed} records a curated, bounded
 *   DELIVERY failure reason (saved -> failed), retaining the saved response.
 * - {@link IdempotencyStore.markSent} confirms delivery (saved|failed ->
 *   sent), requiring a saved response.
 * - {@link IdempotencyStore.getSavedResponse} returns a persisted response
 *   only while delivery is unsent (saved|failed) so a reopened store can
 *   redeliver without a second agent turn; it never returns a `sent`
 *   payload (already acked, redelivery forbidden here).
 * - {@link IdempotencyStore.getEntry} returns the full row state.
 * - {@link IdempotencyStore.close} closes the SQLite handle.
 *
 * Storage: the database path is supplied explicitly by the caller; this
 * store applies no hidden operational default for it. Conversation and
 * correlation ids are opaque strings; this module never interprets them.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { InboundMessage } from "@omp-bundler/contracts/inbound";
import type { OutboundEvent } from "@omp-bundler/contracts/outbound";

/**
 * Event types that close a correlation. A turn ends by replying, failing, or
 * being superseded by a newer addressed message.
 */
const TERMINAL_EVENT_TYPES: Record<string, true> = {
  "turn.reply": true,
  "turn.error": true,
  "turn.cancelled": true,
};

function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES[type] === true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing an {@link IdempotencyStore}. */
export interface IdempotencyStoreOptions {
  /**
   * Filesystem path to the SQLite database file. There is no default; the
   * caller supplies it explicitly. Parent directories are created if
   * missing. Use `:memory:` for an ephemeral, in-memory store (testing).
   */
  dbPath: string;
}

/** Ingest track of an idempotency row. */
export type IngestState = "pending" | "completed";

/** Delivery track of an idempotency row. */
export type DeliveryState = "pending" | "saved" | "sent" | "failed";

/** A full idempotency row as read back from the store. */
export interface IdempotencyEntry {
  /** Adapter id namespacing the message id. */
  adapterId: string;
  /** Opaque message id within the adapter. */
  messageId: string;
  /** Opaque conversation key from the inbound message (stored, not interpreted). */
  conversationKey: string;
  /** Core-generated, opaque, stable correlation id for this key. */
  correlationId: string;
  /** Lowercase hex SHA-256 of the canonicalized inbound message. */
  payloadHash: string;
  /** Ingest track state. */
  ingestState: IngestState;
  /** Delivery track state. */
  deliveryState: DeliveryState;
  /** Saved terminal event, present when delivery is saved, sent, or failed;
   * null only while delivery is pending. */
  response: OutboundEvent | null;
  /** Curated, bounded DELIVERY failure reason; present only when delivery is
   * failed. Not a model error (model errors are saved as turn.error via
   * saveResponse). */
  errorText: string | null;
  /** UTC ISO 8601 timestamp (Z-suffixed) of row creation. */
  createdAt: string;
  /** UTC ISO 8601 timestamp (Z-suffixed) of the last mutation. */
  updatedAt: string;
}

/** First acceptance: a brand-new correlation id was created atomically. */
export interface BeginInboundCreated {
  kind: "created";
  correlationId: string;
}

/** Existing row, turn still in flight (no terminal response yet). */
export interface BeginInboundPending {
  kind: "pending";
  correlationId: string;
}

/** Existing row, completed terminal event saved and ready to redeliver. */
export interface BeginInboundResponseSaved {
  kind: "response-saved";
  correlationId: string;
  /** The persisted terminal event; redeliver this. */
  response: OutboundEvent;
}

/** Existing row, terminal event already confirmed delivered. */
export interface BeginInboundAlreadySent {
  kind: "already-sent";
  correlationId: string;
}

/** Existing row, delivery failed but response retained; caller redelivers
 * the saved response and may report the curated delivery-failure reason. */
export interface BeginInboundDeliveryFailed {
  kind: "delivery-failed";
  correlationId: string;
  /** The persisted terminal event retained from the prior save; redeliver
   * this without a second agent turn. */
  response: OutboundEvent;
  /** Curated, bounded delivery failure reason recorded by the prior
   * markFailed. */
  error: string;
}

/**
 * Result of {@link IdempotencyStore.beginInbound}. The `kind` discriminates
 * the row state for an existing key and signals whether a new correlation
 * id was just created.
 */
export type BeginInboundResult =
  | BeginInboundCreated
  | BeginInboundPending
  | BeginInboundResponseSaved
  | BeginInboundAlreadySent
  | BeginInboundDeliveryFailed;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_store (
  adapter_id       TEXT    NOT NULL,
  message_id       TEXT    NOT NULL,
  conversation_key TEXT    NOT NULL,
  correlation_id   TEXT    NOT NULL,
  payload_hash     TEXT    NOT NULL,
  ingest_state     TEXT    NOT NULL,
  delivery_state   TEXT    NOT NULL,
  response_payload TEXT,
  error_text       TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  PRIMARY KEY (adapter_id, message_id),
  CHECK (ingest_state IN ('pending', 'completed')),
  CHECK (delivery_state IN ('pending', 'saved', 'sent', 'failed')),
  CHECK (
    (delivery_state = 'pending' AND response_payload IS NULL)
    OR (delivery_state IN ('saved', 'sent', 'failed') AND response_payload IS NOT NULL)
  ),
  CHECK (
    (delivery_state = 'failed' AND error_text IS NOT NULL)
    OR (delivery_state IN ('pending', 'saved', 'sent') AND error_text IS NULL)
  )
);
`;

/**
 * Maximum length, in UTF-16 code units, of curated error text stored on a
 * failed row. Longer text is truncated with a trailing marker so the store
 * never persists unbounded error diagnosis.
 */
const MAX_ERROR_TEXT_LEN = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current time as a UTC ISO 8601 string, always suffixed with `Z`. */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Recursively canonicalize a parsed JSON value: object keys are sorted at
 * every depth, arrays keep element order but recurse into each element, and
 * primitives are returned unchanged. A value with `undefined` fields is
 * canonicalized the same as one with those fields absent (JSON.stringify
 * drops them), so an omitted optional and an explicitly-undefined optional
 * hash identically.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 (lowercase hex) over the canonicalized inbound message. Property
 * order in the source JSON does not affect the digest; only the sorted,
 * value-equal canonical form is hashed.
 */
function canonicalPayloadHash(message: InboundMessage): string {
  const canonical = canonicalize(message);
  const text = JSON.stringify(canonical);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Coerce an error value into a curated, bounded string: collapse runs of
 * whitespace to single spaces, trim, and truncate to
 * {@link MAX_ERROR_TEXT_LEN} with a trailing `...` marker when truncated.
 */
function curateErrorText(input: unknown): string {
  const text =
    input === null || input === undefined
      ? ""
      : typeof input === "string"
        ? input
        : String(input);
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_ERROR_TEXT_LEN) return collapsed;
  return collapsed.slice(0, MAX_ERROR_TEXT_LEN - 3) + "...";
}

/**
 * Map a raw database row (snake_case columns) into an
 * {@link IdempotencyEntry}. The response payload is parsed back into an
 * {@link OutboundEvent} only when present; a corrupt payload throws rather
 * than silently degrading.
 */
function rowToEntry(row: Record<string, unknown>): IdempotencyEntry {
  const responseText = row.response_payload as string | null;
  let response: OutboundEvent | null = null;
  if (responseText !== null) {
    response = JSON.parse(responseText) as OutboundEvent;
  }
  return {
    adapterId: row.adapter_id as string,
    messageId: row.message_id as string,
    conversationKey: row.conversation_key as string,
    correlationId: row.correlation_id as string,
    payloadHash: row.payload_hash as string,
    ingestState: row.ingest_state as IngestState,
    deliveryState: row.delivery_state as DeliveryState,
    response,
    errorText: (row.error_text as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// IdempotencyStore
// ---------------------------------------------------------------------------

/**
 * A durable, synchronous SQLite idempotency store keyed by
 * (adapterId, messageId). Tracks ingest and delivery states separately and
 * persists terminal responses so a crash after save reopens to a
 * redeliverable result without a second agent turn.
 */
export class IdempotencyStore {
  private readonly db: Database;
  private closed = false;

  /**
   * Open (or create) the idempotency database. The schema is applied
   * idempotently so reopening an existing file is safe. SQLite WAL mode is
   * enabled for concurrent-reader throughput with serialized writers. The
   * database path is required; this constructor applies no hidden default.
   */
  constructor(options: IdempotencyStoreOptions) {
    const dbPath = options.dbPath;

    if (dbPath !== ":memory:") {
      const slash = dbPath.lastIndexOf("/");
      const dir = slash > 0 ? dbPath.substring(0, slash) : "";
      if (dir) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
  }

  // ---- begin ----

  /**
   * Idempotent begin for an inbound message.
   *
   * Computes the canonical payload hash and atomically inserts a fresh row or
   * classifies the existing row for the same key. `correlationId` may attach a
   * new message to an already-active conversation turn; when omitted, the
   * store generates one.
   *
   * - new row             -> `created`
   * - hash mismatch       -> throws {@link IdempotencyConflictError}
   * - hash match, sent    -> `already-sent`
   * - hash match, saved   -> `response-saved`
   * - hash match, failed  -> `delivery-failed` with the retained response
   * - hash match, pending -> `pending`
   *
   * Existing rows always retain and return their original correlation id.
   */
  beginInbound(
    adapterId: string,
    message: InboundMessage,
    correlationId?: string,
  ): BeginInboundResult {
    if (!adapterId) throw new Error("adapterId is required");
    if (!message) throw new Error("message is required");
    if (!message.messageId) throw new Error("message.messageId is required");
    if (correlationId !== undefined && correlationId.length === 0) {
      throw new Error("correlationId must be non-empty when provided");
    }

    const payloadHash = canonicalPayloadHash(message);
    const existing = this.getRaw(adapterId, message.messageId);

    if (!existing) {
      const assignedCorrelationId = correlationId ?? randomUUID();
      const ts = nowUtc();
      const tx = this.db.transaction(() => {
        this.db.run(
          `INSERT INTO idempotency_store
               (adapter_id, message_id, conversation_key, correlation_id,
                payload_hash, ingest_state, delivery_state,
                response_payload, error_text, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 'pending', NULL, NULL, ?, ?)`,
          [
            adapterId,
            message.messageId,
            message.conversationKey,
            assignedCorrelationId,
            payloadHash,
            ts,
            ts,
          ],
        );
      });
      try {
        tx();
      } catch (err) {
        // A race inserted the same key between our read and this insert.
        // Re-read and classify rather than surfacing a raw constraint error.
        const raced = this.getRaw(adapterId, message.messageId);
        if (raced && raced.payloadHash === payloadHash) {
          return this.classifyExisting(raced);
        }
        if (raced) {
          throw new IdempotencyConflictError(
            adapterId,
            message.messageId,
            payloadHash,
            raced.payloadHash,
          );
        }
        throw err;
      }
      return { kind: "created", correlationId: assignedCorrelationId };
    }

    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(
        adapterId,
        message.messageId,
        payloadHash,
        existing.payloadHash,
      );
    }

    return this.classifyExisting(existing);
  }

  // ---- ingest ----

  /**
   * Remove a newly-created row when ingest could not be accepted.
   *
   * This is the rollback boundary for failures before a passive append or RPC
   * prompt is acknowledged. It deletes only a fully pending row, allowing the
   * adapter to retry the same message. Once ingest completes or any response
   * is saved, the row is durable and this transition is rejected.
   */
  discardPendingInbound(adapterId: string, messageId: string): void {
    const info = this.db.run(
      `DELETE FROM idempotency_store
        WHERE adapter_id     = ?
          AND message_id     = ?
          AND ingest_state   = 'pending'
          AND delivery_state = 'pending'
          AND response_payload IS NULL`,
      [adapterId, messageId],
    );
    if (info.changes === 0) {
      const row = this.getRaw(adapterId, messageId);
      if (!row) {
        throw new InvalidStateTransitionError(
          adapterId,
          messageId,
          `no idempotency entry for adapter="${adapterId}" message="${messageId}"`,
        );
      }
      throw new InvalidStateTransitionError(
        adapterId,
        messageId,
        `cannot discard accepted idempotency entry for adapter="${adapterId}" message="${messageId}"`,
      );
    }
  }

  /**
   * Advance ingest state pending -> completed. Compare-and-set: throws
   * {@link InvalidStateTransitionError} if the row is absent or not pending.
   */
  markIngestComplete(adapterId: string, messageId: string): void {
    const ts = nowUtc();
    const info = this.db.run(
      `UPDATE idempotency_store
          SET ingest_state = 'completed',
              updated_at   = ?
        WHERE adapter_id    = ?
          AND message_id    = ?
          AND ingest_state  = 'pending'`,
      [ts, adapterId, messageId],
    );
    if (info.changes === 0) {
      this.assertRowExists(adapterId, messageId, "ingest_state", "pending");
    }
  }

  // ---- delivery ----

  /**
   * Save a terminal event before delivery: delivery pending -> saved.
   * Atomically completes ingest as well, because a terminal child event proves
   * the prompt was accepted even when it arrives before the RPC acknowledgement.
   * The event must be a terminal `turn.reply` or `turn.error` whose
   * correlationId and conversationKey match the stored row. A model/turn error
   * IS a `turn.error` event saved here, never a markFailed from the pending
   * state. The event is serialized as JSON.
   * Compare-and-set: throws {@link InvalidStateTransitionError} if the row is
   * absent or delivery is not pending. Throws loudly on a non-terminal event
   * type or a correlation/conversation mismatch.
   */
  saveResponse(
    adapterId: string,
    messageId: string,
    event: OutboundEvent,
  ): void {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new Error("event must be an OutboundEvent with a string type");
    }
    if (!isTerminalEventType(event.type)) {
      throw new Error(
        `saveResponse accepts only terminal events, got "${event.type}"`,
      );
    }
    // Correlation id and conversation key are immutable post-insert, so a
    // pre-read check is race-safe; the CAS below still guards state.
    const row = this.getRaw(adapterId, messageId);
    if (!row) {
      throw new InvalidStateTransitionError(
        adapterId,
        messageId,
        `no idempotency entry for adapter="${adapterId}" message="${messageId}"`,
      );
    }
    if (row.correlationId !== event.correlationId) {
      throw new Error(
        `event.correlationId mismatch for adapter="${adapterId}" message="${messageId}"` +
          ` (expected ${row.correlationId}, got ${event.correlationId})`,
      );
    }
    if (row.conversationKey !== event.conversationKey) {
      throw new Error(
        `event.conversationKey mismatch for adapter="${adapterId}" message="${messageId}"` +
          ` (expected ${row.conversationKey}, got ${event.conversationKey})`,
      );
    }
    const ts = nowUtc();
    const payload = JSON.stringify(event);
    const info = this.db.run(
      `UPDATE idempotency_store
          SET ingest_state     = 'completed',
              delivery_state   = 'saved',
              response_payload = ?,
              error_text       = NULL,
              updated_at       = ?
        WHERE adapter_id     = ?
          AND message_id     = ?
          AND delivery_state = 'pending'`,
      [payload, ts, adapterId, messageId],
    );
    if (info.changes === 0) {
      const fresh = this.getRaw(adapterId, messageId);
      throw new InvalidStateTransitionError(
        adapterId,
        messageId,
        `saveResponse requires delivery_state=pending` +
          ` for adapter="${adapterId}" message="${messageId}"` +
          ` but found delivery_state=${fresh?.deliveryState ?? "absent"}`,
      );
    }
  }

  /**
   * Confirm delivery of a saved/failed response: saved|failed -> sent. The
   * response payload is retained but delivery is now terminal; further
   * redelivery is the adapter's at-least-once concern, not this store's
   * (getSavedResponse returns null once sent). Compare-and-set: throws
   * {@link InvalidStateTransitionError} if the row is absent or delivery is
   * not saved|failed (a saved response is required).
   */
  markSent(adapterId: string, messageId: string): void {
    const ts = nowUtc();
    const info = this.db.run(
      `UPDATE idempotency_store
          SET delivery_state = 'sent',
              error_text     = NULL,
              updated_at     = ?
        WHERE adapter_id    = ?
          AND message_id    = ?
          AND delivery_state IN ('saved', 'failed')`,
      [ts, adapterId, messageId],
    );
    if (info.changes === 0) {
      this.assertRowExists(
        adapterId,
        messageId,
        "delivery_state",
        "saved|failed",
      );
    }
  }

  /**
   * Record a DELIVERY failure: saved -> failed, storing a curated, bounded
   * delivery failure reason. The saved response_payload is RETAINED so a
   * retry redelivers the same expensive payload without a second agent turn.
   * A model/turn error is never recorded here; it is saved as a turn.error
   * event via saveResponse. Compare-and-set: throws
   * {@link InvalidStateTransitionError} if the row is absent or delivery is
   * not saved (no response to retain).
   */
  markFailed(adapterId: string, messageId: string, error: unknown): void {
    const ts = nowUtc();
    const curated = curateErrorText(error);
    const info = this.db.run(
      `UPDATE idempotency_store
          SET delivery_state = 'failed',
              error_text     = ?,
              updated_at     = ?
        WHERE adapter_id    = ?
          AND message_id    = ?
          AND delivery_state = 'saved'`,
      [curated, ts, adapterId, messageId],
    );
    if (info.changes === 0) {
      this.assertRowExists(adapterId, messageId, "delivery_state", "saved");
    }
  }

  /**
   * Atomically save one terminal response across every inbound row attached to
   * a correlation. Existing rows already carrying the same event are retained.
   */
  saveResponseForCorrelation(
    adapterId: string,
    correlationId: string,
    event: OutboundEvent,
  ): void {
    if (!isTerminalEventType(event.type)) {
      throw new Error(
        `correlation response must be terminal, got "${event.type}"`,
      );
    }
    if (event.correlationId !== correlationId) {
      throw new Error(
        `event.correlationId mismatch for correlation "${correlationId}"`,
      );
    }
    const entries = this.getEntriesByCorrelation(adapterId, correlationId);
    if (entries.length === 0) {
      throw new Error(
        `no idempotency entries for correlation "${correlationId}"`,
      );
    }
    let pending = 0;
    for (const entry of entries) {
      if (entry.conversationKey !== event.conversationKey) {
        throw new Error(
          `event.conversationKey mismatch for adapter="${adapterId}" message="${entry.messageId}"`,
        );
      }
      if (entry.deliveryState === "pending") {
        pending++;
      } else if (entry.response?.eventId !== event.eventId) {
        throw new Error(
          `terminal event mismatch for adapter="${adapterId}" message="${entry.messageId}"`,
        );
      }
    }
    if (pending === 0) return;
    const info = this.db.run(
      `UPDATE idempotency_store
          SET ingest_state     = 'completed',
              delivery_state   = 'saved',
              response_payload = ?,
              error_text       = NULL,
              updated_at       = ?
        WHERE adapter_id      = ?
          AND correlation_id  = ?
          AND delivery_state  = 'pending'`,
      [JSON.stringify(event), nowUtc(), adapterId, correlationId],
    );
    if (info.changes !== pending) {
      throw new Error(
        `correlation "${correlationId}" changed while saving its response`,
      );
    }
  }

  /** Atomically mark the matching terminal response sent for all siblings. */
  markCorrelationSent(
    adapterId: string,
    correlationId: string,
    eventId: string,
  ): void {
    const entries = this.getEntriesByCorrelation(adapterId, correlationId);
    let unsent = 0;
    for (const entry of entries) {
      if (
        entry.response?.eventId !== eventId ||
        (entry.deliveryState !== "saved" &&
          entry.deliveryState !== "failed" &&
          entry.deliveryState !== "sent")
      ) {
        throw new Error(
          `cannot confirm terminal delivery for adapter="${adapterId}" message="${entry.messageId}"`,
        );
      }
      if (entry.deliveryState !== "sent") unsent++;
    }
    if (unsent === 0) return;
    const info = this.db.run(
      `UPDATE idempotency_store
          SET delivery_state = 'sent',
              error_text     = NULL,
              updated_at     = ?
        WHERE adapter_id       = ?
          AND correlation_id   = ?
          AND delivery_state IN ('saved', 'failed')`,
      [nowUtc(), adapterId, correlationId],
    );
    if (info.changes !== unsent) {
      throw new Error(
        `correlation "${correlationId}" changed while marking it sent`,
      );
    }
  }

  /** Atomically retain one delivery failure across all unsent siblings. */
  markCorrelationFailed(
    adapterId: string,
    correlationId: string,
    eventId: string,
    error: unknown,
  ): void {
    const entries = this.getEntriesByCorrelation(adapterId, correlationId);
    let saved = 0;
    for (const entry of entries) {
      if (
        entry.response?.eventId !== eventId ||
        (entry.deliveryState !== "saved" &&
          entry.deliveryState !== "failed" &&
          entry.deliveryState !== "sent")
      ) {
        throw new Error(
          `cannot record terminal failure for adapter="${adapterId}" message="${entry.messageId}"`,
        );
      }
      if (entry.deliveryState === "saved") saved++;
    }
    if (saved === 0) return;
    const info = this.db.run(
      `UPDATE idempotency_store
          SET delivery_state = 'failed',
              error_text     = ?,
              updated_at     = ?
        WHERE adapter_id      = ?
          AND correlation_id  = ?
          AND delivery_state  = 'saved'`,
      [curateErrorText(error), nowUtc(), adapterId, correlationId],
    );
    if (info.changes !== saved) {
      throw new Error(
        `correlation "${correlationId}" changed while marking it failed`,
      );
    }
  }

  // ---- read ----

  /**
   * Return the full row state for a key, or null if no entry exists. Does
   * not mutate the row.
   */
  getEntry(adapterId: string, messageId: string): IdempotencyEntry | null {
    return this.getRaw(adapterId, messageId);
  }

  /**
   * Return the persisted terminal event while delivery is unsent (saved or
   * failed) so a reopened store can redeliver without a second agent turn.
   * Returns null when no row exists, delivery is already sent (acked;
   * redelivery forbidden here to avoid duplicate delivery), or delivery is
   * still pending (no response saved yet).
   */
  getSavedResponse(adapterId: string, messageId: string): OutboundEvent | null {
    const row = this.getRaw(adapterId, messageId);
    if (!row) return null;
    if (row.deliveryState === "saved" || row.deliveryState === "failed") {
      return row.response;
    }
    return null;
  }

  /**
   * Return every inbound row attached to one adapter correlation.
   *
   * Used by outbound recovery to restore terminal delivery hooks after a
   * process restart without replaying the model turn.
   */
  getEntriesByCorrelation(
    adapterId: string,
    correlationId: string,
  ): IdempotencyEntry[] {
    return this.db
      .query(
        `SELECT adapter_id, message_id, conversation_key, correlation_id,
                payload_hash, ingest_state, delivery_state,
                response_payload, error_text, created_at, updated_at
           FROM idempotency_store
          WHERE adapter_id = ?
            AND correlation_id = ?
          ORDER BY created_at, message_id`,
      )
      .all(adapterId, correlationId)
      .map((row) => rowToEntry(row as Record<string, unknown>));
  }

  /** Return saved terminal responses that still need delivery reconciliation. */
  listSavedResponses(): IdempotencyEntry[] {
    return this.db
      .query(
        `SELECT adapter_id, message_id, conversation_key, correlation_id,
                payload_hash, ingest_state, delivery_state,
                response_payload, error_text, created_at, updated_at
           FROM idempotency_store
          WHERE delivery_state = 'saved'
          ORDER BY created_at, adapter_id, correlation_id, message_id`,
      )
      .all()
      .map((row) => rowToEntry(row as Record<string, unknown>));
  }

  // ---- close ----

  /** Close the database handle. Safe to call multiple times. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- internals ----

  private getRaw(
    adapterId: string,
    messageId: string,
  ): IdempotencyEntry | null {
    const row = this.db
      .query(
        `SELECT adapter_id, message_id, conversation_key, correlation_id,
                payload_hash, ingest_state, delivery_state,
                response_payload, error_text, created_at, updated_at
           FROM idempotency_store
          WHERE adapter_id = ?
            AND message_id = ?`,
      )
      .get(adapterId, messageId) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToEntry(row);
  }

  /**
   * Map an existing, hash-matching row to its beginInbound result variant,
   * based on the delivery track.
   */
  private classifyExisting(row: IdempotencyEntry): BeginInboundResult {
    switch (row.deliveryState) {
      case "sent":
        return { kind: "already-sent", correlationId: row.correlationId };
      case "saved":
        return {
          kind: "response-saved",
          correlationId: row.correlationId,
          response: row.response as OutboundEvent,
        };
      case "failed":
        return {
          kind: "delivery-failed",
          correlationId: row.correlationId,
          response: row.response as OutboundEvent,
          error: row.errorText ?? "",
        };
      default:
        return { kind: "pending", correlationId: row.correlationId };
    }
  }

  /**
   * Thrown after a CAS update affects zero rows. Re-reads the row to report
   * whether the key is absent entirely or merely in the wrong state for the
   * attempted transition.
   */
  private assertRowExists(
    adapterId: string,
    messageId: string,
    field: string,
    expected: string,
  ): never {
    const row = this.getRaw(adapterId, messageId);
    if (!row) {
      throw new InvalidStateTransitionError(
        adapterId,
        messageId,
        `no idempotency entry for adapter="${adapterId}" message="${messageId}"`,
      );
    }
    const actual =
      field === "ingest_state"
        ? row.ingestState
        : field === "delivery_state"
          ? row.deliveryState
          : undefined;
    throw new InvalidStateTransitionError(
      adapterId,
      messageId,
      `expected ${field}=${expected} for adapter="${adapterId}" message="${messageId}" but found ${field}=${actual ?? "null"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link IdempotencyStore.beginInbound} when the same
 * (adapterId, messageId) key already holds a row whose canonical payload
 * hash differs from the incoming message. The existing row is never
 * mutated; the original correlation id and payload are preserved.
 */
export class IdempotencyConflictError extends Error {
  readonly adapterId: string;
  readonly messageId: string;
  readonly incomingHash: string;
  readonly existingHash: string;

  constructor(
    adapterId: string,
    messageId: string,
    incomingHash: string,
    existingHash: string,
  ) {
    super(
      `idempotency conflict for adapter="${adapterId}" message="${messageId}"` +
        ` (incoming sha256=${incomingHash}, existing sha256=${existingHash})`,
    );
    this.name = "IdempotencyConflictError";
    this.adapterId = adapterId;
    this.messageId = messageId;
    this.incomingHash = incomingHash;
    this.existingHash = existingHash;
  }
}

/**
 * Thrown by the compare-and-set transition methods when the precondition
 * (expected prior state, or row existence) does not match the row. Carries a
 * descriptive message naming the failing field and expectation.
 */
export class InvalidStateTransitionError extends Error {
  readonly adapterId: string;
  readonly messageId: string;

  constructor(adapterId: string, messageId: string, detail: string) {
    super(detail);
    this.name = "InvalidStateTransitionError";
    this.adapterId = adapterId;
    this.messageId = messageId;
  }
}
