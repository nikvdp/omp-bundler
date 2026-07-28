/**
 * SQLite-backed session registry mapping an adapter id + opaque conversation
 * key to a concrete session file on disk.
 *
 * Each row records the conversation identity (adapter id + conversation key),
 * the filesystem path of the backing OMP session file, UTC ISO timestamps for
 * creation and last activity, and a nullable current owner token. The
 * PRIMARY KEY on (adapter_id, conversation_key) guarantees one conversation
 * maps to exactly one session: no duplicate creation, no shadow sessions.
 *
 * Race safety for ownership is enforced via compare-and-set inside a
 * serialized transaction: two concurrent owners can never acquire the same
 * conversation because the UPDATE is guarded by a WHERE clause on the
 * expected prior owner and the change count is verified. No silent fallbacks:
 * every operation either succeeds with a real, verified result or throws.
 *
 * In-process concurrency for {@link SessionRegistry.getOrCreate} is handled
 * with a keyed in-flight creation map so that two simultaneous calls for the
 * same adapter/key share one `newSession`/`getState` round-trip and cannot
 * orphan a second session. This registry runs inside a single supervisor
 * process; multi-process coordination (two separate Node/Bun processes
 * sharing one database file) is out of scope because launch is
 * single-supervisor. SQLite file locking would serialize writers across
 * processes but the in-flight deduplication is process-local.
 *
 * Lifecycle:
 * - {@link SessionRegistry.create} calls `RpcChild.newSession`, then
 *   `RpcChild.getState`, requires a non-empty `sessionFile` from the returned
 *   state, and only then commits the row.
 * - {@link SessionRegistry.resolve} returns the existing mapping for a
 *   conversation, attaching via `RpcChild.switchSession`.
 * - {@link SessionRegistry.attach} switches a child to a known session file.
 * - {@link SessionRegistry.setOwner} performs compare-and-set ownership.
 * - {@link SessionRegistry.heartbeat} / {@link SessionRegistry.touch} update
 *   the last-active timestamp (heartbeat on the active owner, touch on the
 *   row regardless).
 * - {@link SessionRegistry.release} clears ownership for a conversation.
 * - {@link SessionRegistry.close} closes the SQLite database handle.
 *
 * Storage: the registry database lives on the filesystem (default `/data`) as
 * a single file scoped to the container. The database path is configurable
 * via {@link SessionRegistryOptions.dbPath}. Conversation keys are opaque
 * strings namespaced by adapter id; the registry never interprets their
 * content.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { RpcChild, RpcSessionState } from "./rpc-child.js";
import { conversationStorageKey } from "./adapter-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing a {@link SessionRegistry}. */
export interface SessionRegistryOptions {
  /**
   * Filesystem path to the SQLite database file. Parent directories are
   * created if missing. Use `:memory:` for ephemeral tests.
   */
  dbPath: string;
}

/** A single registry row: the mapping record for one conversation. */
export interface SessionRecord {
  /** Adapter id that owns this conversation (namespaces the conversation key). */
  adapterId: string;
  /** Opaque, adapter-scoped conversation key (never interpreted). */
  conversationKey: string;
  /** Filesystem path to the backing OMP session file. */
  sessionFile: string;
  /** UTC ISO 8601 timestamp of row creation. */
  createdAt: string;
  /** UTC ISO 8601 timestamp of the last activity on this conversation. */
  lastActive: string;
  /** Current owner token, or null if the conversation is unowned. */
  currentOwner: string | null;
}

/** Result of an acquisition attempt. */
export interface AcquireResult {
  record: SessionRecord;
  /** True if this caller is now the owner; false if someone else already is. */
  acquired: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_registry (
  adapter_id       TEXT    NOT NULL,
  conversation_key TEXT    NOT NULL,
  session_file     TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  last_active      TEXT    NOT NULL,
  current_owner    TEXT,
  PRIMARY KEY (adapter_id, conversation_key)
);
`;

const INDEX_OWNER = `
CREATE INDEX IF NOT EXISTS idx_session_registry_owner
  ON session_registry (current_owner);
`;

/** SQLite error codes that indicate a uniqueness/PK constraint violation. */
const CONSTRAINT_CODES: Record<string, true> = {
  SQLITE_CONSTRAINT_PRIMARYKEY: true,
  SQLITE_CONSTRAINT_UNIQUE: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current time as a UTC ISO 8601 string (always Z-suffixed). */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Map a raw database row (snake_case, possibly null owner) to a
 * {@link SessionRecord}.
 */
function rowToRecord(row: Record<string, unknown>): SessionRecord {
  return {
    adapterId: String(row.adapter_id),
    conversationKey: String(row.conversation_key),
    sessionFile: String(row.session_file),
    createdAt: String(row.created_at),
    lastActive: String(row.last_active),
    currentOwner: row.current_owner === null || row.current_owner === undefined
      ? null
      : String(row.current_owner),
  };
}

/** Shared collision-proof key for the in-flight creation map. */
const conversationKeyOf = conversationStorageKey;

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

/**
 * A persistent, race-safe registry mapping adapter-id + conversation key to
 * an OMP session file.
 */
export class SessionRegistry {
  private readonly db: Database;
  private readonly ownsDb: boolean;

  /**
   * In-process in-flight creation map. When a `getOrCreate` (or `create`)
   * call starts a `newSession` round-trip for a given adapter/key, a Promise
   * is stored here so a concurrent second call awaits the same Promise
   * instead of spawning a second (orphaned) session. Cleared on completion.
   */
  private readonly inflight = new Map<string, Promise<SessionRecord>>();

  /**
   * Open (or create) the registry database. The schema is applied
   * idempotently. SQLite WAL mode is enabled for concurrent-reader throughput
   * with serialized writers.
   */
  constructor(options: SessionRegistryOptions) {
    const dbPath = options.dbPath;

    if (dbPath !== ":memory:") {
      const slash = dbPath.lastIndexOf("/");
      const dir = slash > 0 ? dbPath.substring(0, slash) : "";
      if (dir) {
        // Create parent dirs explicitly; let real errors propagate rather
        // than swallowing them. The Database open below would fail anyway,
        // but swallowing hides the root cause.
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.ownsDb = true;

    // Performance: WAL allows concurrent readers with a single writer.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
    this.db.run(INDEX_OWNER);
  }

  // ---- create ----

  /**
   * Create a new session for a conversation: call `RpcChild.newSession`, then
   * `RpcChild.getState`, require a real `sessionFile` in the returned state,
   * and commit the row. If the conversation already exists, throws; callers
   * should use {@link resolve} or {@link getOrCreate} for idempotent flows.
   *
   * @throws if `newSession` or `getState` fails, if no `sessionFile` is
   *   returned, or if the conversation already has a mapping.
   */
  async create(
    child: RpcChild,
    adapterId: string,
    conversationKey: string,
  ): Promise<SessionRecord> {
    if (!adapterId) throw new Error("adapterId is required");
    if (!conversationKey) throw new Error("conversationKey is required");

    // Guard against duplicate creation before touching the child process.
    const existing = this.getRaw(adapterId, conversationKey);
    if (existing) {
      throw new Error(
        `session already exists for adapter="${adapterId}" key="${conversationKey}"`,
      );
    }

    // Step 1: create the session in the child.
    const newRes = await child.newSession();
    if (!newRes.success) {
      throw new Error(`new_session failed: ${newRes.error ?? "unknown"}`);
    }

    // Step 2: read back the state to discover the session file path.
    const stateRes = await child.getState();
    if (!stateRes.success) {
      throw new Error(`get_state failed: ${stateRes.error ?? "unknown"}`);
    }

    const state = stateRes.data as RpcSessionState | undefined;
    if (!state) {
      throw new Error("get_state returned no data");
    }

    const sessionFile = state.sessionFile;
    if (!sessionFile || typeof sessionFile !== "string") {
      throw new Error(
        "get_state returned no sessionFile; cannot create session registry entry",
      );
    }

    // Step 3: commit. Use INSERT OR FAIL so a race-condition duplicate
    // (inserted between our guard check and here) throws rather than silently
    // overwrites. Only SQLite constraint errors are classified as a
    // duplicate race; all other errors are rethrown unchanged.
    const ts = nowUtc();
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO session_registry
             (adapter_id, conversation_key, session_file, created_at, last_active, current_owner)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        [adapterId, conversationKey, sessionFile, ts, ts],
      );
    });
    try {
      tx();
    } catch (err) {
      if (isConstraintError(err)) {
        throw new Error(
          `session already exists for adapter="${adapterId}" key="${conversationKey}" (race)`,
        );
      }
      throw err;
    }

    return {
      adapterId,
      conversationKey,
      sessionFile,
      createdAt: ts,
      lastActive: ts,
      currentOwner: null,
    };
  }

  /**
   * Idempotent create-or-resolve. If a mapping already exists it is returned
   * (and the child is attached via `switchSession`, with success verified);
   * otherwise a new session is created. The owner is NOT changed by this
   * method.
   *
   * Two concurrent calls for the same adapter/key share the same in-flight
   * creation Promise, so only one `newSession`/`getState` round-trip is
   * issued and no second session is orphaned.
   */
  async getOrCreate(
    child: RpcChild,
    adapterId: string,
    conversationKey: string,
  ): Promise<SessionRecord> {
    const existing = this.getRaw(adapterId, conversationKey);
    if (existing) {
      const res = await child.switchSession(existing.sessionFile);
      if (!res.success) {
        throw new Error(
          `switch_session failed for "${existing.sessionFile}": ${res.error ?? "unknown"}`,
        );
      }
      return existing;
    }

    // Deduplicate in-process concurrent creation: if another call is already
    // mid-flight for this conversation, await its result.
    const key = conversationKeyOf(adapterId, conversationKey);
    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = this.create(child, adapterId, conversationKey)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  // ---- resolve / attach ----

  /**
   * Resolve the session file for a conversation and attach the child to it
   * via `switchSession`. Returns the record. Does not claim ownership.
   *
   * @throws if no mapping exists or `switchSession` fails.
   */
  async resolve(
    child: RpcChild,
    adapterId: string,
    conversationKey: string,
  ): Promise<SessionRecord> {
    const row = this.getRaw(adapterId, conversationKey);
    if (!row) {
      throw new Error(
        `no session mapping for adapter="${adapterId}" key="${conversationKey}"`,
      );
    }
    const res = await child.switchSession(row.sessionFile);
    if (!res.success) {
      throw new Error(
        `switch_session failed for "${row.sessionFile}": ${res.error ?? "unknown"}`,
      );
    }
    return row;
  }

  /**
   * Attach a child to a session file by path (no registry lookup). Useful
   * when the path is already known. Calls `switchSession` and verifies
   * success.
   */
  async attach(child: RpcChild, sessionFile: string): Promise<void> {
    const res = await child.switchSession(sessionFile);
    if (!res.success) {
      throw new Error(
        `switch_session failed for "${sessionFile}": ${res.error ?? "unknown"}`,
      );
    }
  }

  // ---- ownership (compare-and-set) ----

  /**
   * Compare-and-set ownership of a conversation.
   *
   * - If `currentOwner` is null, ownership is granted to `newOwner` only when
   *   the row's current owner is null (atomic acquire).
   * - If `currentOwner` is a string, ownership is transferred to `newOwner`
   *   only when the row's current owner matches `currentOwner` (atomic
   *   transfer/release-and-reacquire).
   *
   * The entire check-and-update runs inside a serialized transaction with a
   * WHERE guard, so two concurrent callers can never both succeed. The
   * change count is verified: zero changes means the precondition did not
   * hold and the operation throws.
   *
   * On success, `last_active` is advanced to now.
   */
  setOwner(
    adapterId: string,
    conversationKey: string,
    currentOwner: string | null,
    newOwner: string | null,
  ): AcquireResult {
    const ts = nowUtc();
    const tx = this.db.transaction(() => {
      const info = this.db.run(
        `UPDATE session_registry
            SET current_owner = ?,
                last_active   = ?
          WHERE adapter_id = ?
            AND conversation_key = ?
            AND current_owner IS ?`,
        [newOwner, ts, adapterId, conversationKey, currentOwner],
      );
      if (info.changes === 0) {
        throw new OwnerMismatchError(adapterId, conversationKey, currentOwner);
      }
    });
    tx();

    const record = this.getRaw(adapterId, conversationKey);
    if (!record) {
      // Should be unreachable given the UPDATE succeeded.
      throw new Error(
        `session disappeared after setOwner for adapter="${adapterId}" key="${conversationKey}"`,
      );
    }

    return { record, acquired: newOwner !== null };
  }

  // ---- heartbeat / touch ----

  /**
   * Heartbeat: advance `last_active` to now, but only if the caller is the
   * current owner. Returns true if the heartbeat was accepted (caller is
   * owner), false otherwise. No silent fallback: a false return is an
   * explicit signal that the caller is not the owner.
   */
  heartbeat(
    adapterId: string,
    conversationKey: string,
    owner: string,
  ): boolean {
    const ts = nowUtc();
    const info = this.db.run(
      `UPDATE session_registry
          SET last_active = ?
        WHERE adapter_id = ?
          AND conversation_key = ?
          AND current_owner = ?`,
      [ts, adapterId, conversationKey, owner],
    );
    return info.changes > 0;
  }

  /**
   * Touch: advance `last_active` to now for a conversation regardless of
   * ownership. Returns true if the row exists and was updated, false if no
   * mapping exists.
   */
  touch(adapterId: string, conversationKey: string): boolean {
    const ts = nowUtc();
    const info = this.db.run(
      `UPDATE session_registry
          SET last_active = ?
        WHERE adapter_id = ?
          AND conversation_key = ?`,
      [ts, adapterId, conversationKey],
    );
    return info.changes > 0;
  }

  // ---- release ----

  /**
   * Release ownership of a conversation. Only succeeds if the caller is the
   * current owner (compare-and-set with newOwner = null). Throws if the
   * conversation has no mapping or the caller is not the owner.
   */
  release(
    adapterId: string,
    conversationKey: string,
    owner: string,
  ): SessionRecord {
    const ts = nowUtc();
    const tx = this.db.transaction(() => {
      const info = this.db.run(
        `UPDATE session_registry
            SET current_owner = NULL,
                last_active   = ?
          WHERE adapter_id = ?
            AND conversation_key = ?
            AND current_owner = ?`,
        [ts, adapterId, conversationKey, owner],
      );
      if (info.changes === 0) {
        const row = this.getRaw(adapterId, conversationKey);
        if (!row) {
          throw new Error(
            `no session mapping for adapter="${adapterId}" key="${conversationKey}"`,
          );
        }
        throw new OwnerMismatchError(adapterId, conversationKey, owner);
      }
    });
    tx();

    const record = this.getRaw(adapterId, conversationKey);
    if (!record) {
      throw new Error(
        `session disappeared after release for adapter="${adapterId}" key="${conversationKey}"`,
      );
    }
    return record;
  }

  // ---- read ----

  /**
   * Get the record for a conversation, or null if no mapping exists. Does
   * not touch the child process or modify the row.
   */
  get(adapterId: string, conversationKey: string): SessionRecord | null {
    return this.getRaw(adapterId, conversationKey);
  }

  // ---- close ----

  /** Close the underlying database handle. Safe to call multiple times. */
  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  // ---- internals ----

  private getRaw(
    adapterId: string,
    conversationKey: string,
  ): SessionRecord | null {
    const row = this.db
      .query(
        `SELECT adapter_id, conversation_key, session_file,
                created_at, last_active, current_owner
           FROM session_registry
          WHERE adapter_id = ?
            AND conversation_key = ?`,
      )
      .get(adapterId, conversationKey) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToRecord(row);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link SessionRegistry.setOwner} and
 * {@link SessionRegistry.release} when the compare-and-set precondition
 * (expected current owner) does not match the row's actual owner.
 */
export class OwnerMismatchError extends Error {
  readonly adapterId: string;
  readonly conversationKey: string;
  readonly expectedOwner: string | null;

  constructor(
    adapterId: string,
    conversationKey: string,
    expectedOwner: string | null,
  ) {
    super(
      `owner mismatch for adapter="${adapterId}" key="${conversationKey}"` +
        ` (expected owner=${expectedOwner ?? "null"})`,
    );
    this.name = "OwnerMismatchError";
    this.adapterId = adapterId;
    this.conversationKey = conversationKey;
    this.expectedOwner = expectedOwner;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` is a SQLite constraint error indicating a uniqueness
 * or primary-key violation (i.e. a duplicate insert). Only these are
 * classified as a duplicate-race; all other errors are surfaced unchanged.
 */
function isConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (!("code" in err) || typeof err.code !== "string") return false;
  return CONSTRAINT_CODES[err.code] === true;
}