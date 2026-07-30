/**
 * Bounded child-process lease pool for the OMP core runtime.
 *
 * A single {@link PoolManager} supervisor owns exactly one
 * {@link SessionRegistry} and manages a bounded set of live {@link RpcChild}
 * processes. At most one live child exists per `(adapterId, conversationKey)`
 * pair. Leases are acquired, used, and released back to the pool; idle children
 * are swept after a configurable timeout. When the pool is at capacity, the
 * least-recently-used idle child is evicted to make room. If every child is
 * in use, new acquire requests enter a FIFO wait queue and resolve in arrival
 * order as leases are released.
 *
 * History revival: when an acquire targets a conversation that has a registry
 * mapping but no in-memory child, the pool creates a fresh child through the
 * injected async factory and attaches it to the stored session file via
 * `SessionRegistry.getOrCreate` (which calls `switchSession` internally).
 *
 * Ownership: each live child carries a unique owner token. The registry's
 * compare-and-set ownership primitives are used so that a stale owner recorded
 * in the database can be transferred to the new supervisor at startup sweep
 * time, and subsequent ownership transitions are race-safe.
 *
 * Close-before-release invariant: a child is always closed before its registry
 * ownership is CAS-released. If close fails, ownership is retained so the
 * startup sweep can recover. Close and release failures are surfaced, not
 * swallowed.
 */
import { randomUUID } from "node:crypto";
import { conversationStorageKey } from "./adapter-registry.js";
import type { RpcChild } from "./rpc-child.js";
import {
  type SessionRegistry,
  OwnerMismatchError,
} from "./session-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to {@link ChildFactory} so the supervisor can construct an
 * RpcChild with the persistent reaper key and any conversation-scoped wiring.
 */
export interface ChildFactoryContext {
  adapterId: string;
  conversationKey: string;
  /**
   * The collision-proof adapter-scoped conversation key. Stable across
   * revivals; the supervisor can use it as a deterministic reaper identifier.
   */
  registryKey: string;
}

/**
 * Async factory that creates and starts a fresh {@link RpcChild}. Injected so
 * the pool never imports spawn/adapter wiring directly. The returned child
 * must already be started (ready frame received).
 */
export type ChildFactory = (ctx: ChildFactoryContext) => Promise<RpcChild>;

/** A live, in-memory child tracked by the pool, keyed by conversation. */
interface PoolEntry {
  child: RpcChild;
  adapterId: string;
  conversationKey: string;
  /** Unique ownership token recorded in the registry for this child. */
  ownerToken: string;
  /** True while a lease is held; idle children are candidates for eviction. */
  inUse: boolean;
  /** Known-bad child awaiting confirmed exit; never lease it again. */
  retiring: boolean;
  /** Monotonic timestamp of the last lease release (or creation if never leased). */
  lastUsedAt: number;
  /** Timer handle for the idle-timeout sweep, if scheduled. */
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Stage-aware result of tearing down an entry. The stage determines whether
 * the child is still alive (capacity slot must remain occupied) or dead
 * (slot may be freed, but release may still have failed).
 *
 * - `"child_closed"`: child exited and ownership released. Slot is free.
 * - `"close_failed"`: child.close() threw. The child may still be alive.
 *   Ownership is retained. The entry must be restored as an occupied idle
 *   slot so the pool does not over-allocate. Startup sweep can recover.
 * - `"release_failed"`: child exited but registry.release() threw. The
 *   child is dead; the slot is free. The release failure is surfaced for
 *   aggregation but does not block capacity.
 */
interface TeardownResult {
  stage: "child_closed" | "close_failed" | "release_failed";
  error?: Error;
}

/**
 * Outcome of a single synchronous eviction. `ok:false` is produced when a
 * child-close failure restores the entry, or when another operation removed
 * the candidate before this operation claimed it.
 */
type EvictOutcome =
  | { ok: true }
  | { ok: false; reason: "unavailable" }
  | { ok: false; reason: "close_failed"; error: Error };

/**
 * Outcome of an idle-eviction sweep for capacity. `all_in_use` means no idle
 * child exists to evict; `close_failed` means idle children were found but
 * every close attempt failed (each restored as an occupied idle slot).
 */
type EvictForCapacityOutcome =
  | { ok: true }
  | { ok: false; reason: "all_in_use" }
  | { ok: false; reason: "close_failed"; error: Error };

/** A queued waiter blocked because the pool is at capacity with all-active leases. */
interface Waiter {
  adapterId: string;
  conversationKey: string;
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
}

/** A held lease. Must be released exactly once via {@link Lease.release}. */
export interface Lease {
  child: RpcChild;
  adapterId: string;
  conversationKey: string;
  /** Release the lease back to the pool. Idempotent: subsequent calls are no-ops. */
  release: () => void;
}

/** Structured event emitted through the logger callback. */
export interface PoolLogEvent {
  type:
    | "cap_reached"
    | "eviction"
    | "revival"
    | "wait_enqueued"
    | "wait_resolved"
    | "wait_cancelled"
    | "idle_sweep"
    | "child_closed"
    | "ownership_release_failed"
    | "ownership_retained"
    | "create_failed";
  adapterId?: string;
  conversationKey?: string;
  size?: number;
  waiters?: number;
  message: string;
}

/** Callback for structured pool events (cap/eviction/revival/wait/sweep). */
export type PoolLogger = (event: PoolLogEvent) => void;

/** Observable snapshot of pool state for validation. */
export interface PoolStats {
  /** Number of live children currently held in the pool. */
  size: number;
  /** Number of children with an active lease. */
  activeLeases: number;
  /** Number of idle children (no active lease). */
  idle: number;
  /** Number of callers blocked in the FIFO wait queue. */
  waiters: number;
  /** Number of children in the process of closing (capacity still occupied). */
  closing: number;
  /** Maximum number of live children allowed. */
  maxChildren: number;
}

/** Options for constructing a {@link PoolManager}. */
export interface PoolManagerOptions {
  /**
   * The {@link SessionRegistry} owned by this supervisor. The pool does not
   * close it on {@link PoolManager.close}; the caller is responsible for the
   * registry lifecycle if it was created externally.
   */
  registry: SessionRegistry;
  /**
   * Async factory that creates and starts a fresh {@link RpcChild}. The pool
   * calls this exactly once per revived conversation; the returned child must
   * be ready (started, ready frame received).
   */
  factory: ChildFactory;
  /**
   * Hard cap on the number of live children the pool may hold simultaneously.
   * Required; no hidden default. Must be a positive integer.
   */
  maxChildren: number;
  /**
   * Idle timeout in milliseconds. A child whose lease has been released for
   * this long without being reacquired is closed and removed from the pool.
   * Required; no hidden default. Must be a positive integer.
   */
  idleTimeoutMs: number;
  /**
   * Required structured logger invoked for cap, eviction, revival, wait, and
   * sweep events. Cap binding and eviction logging are invariants; the logger
   * must not be omitted.
   */
  logger: PoolLogger;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link PoolManager.acquire} when the manager has been closed and a
 * caller attempts to acquire a new lease.
 */
export class PoolClosedError extends Error {
  constructor() {
    super("PoolManager is closed");
    this.name = "PoolClosedError";
  }
}

/**
 * Aggregated close failure: one or more children failed to close or one or
 * more registry ownership releases failed. The `errors` array preserves
 * individual failures in source order.
 */
export class PoolCloseError extends Error {
  readonly errors: Error[];
  constructor(errors: Error[]) {
    super(`pool close encountered ${errors.length} error(s)`);
    this.name = "PoolCloseError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// PoolManager
// ---------------------------------------------------------------------------

export class PoolManager {
  private readonly registry: SessionRegistry;
  private readonly factory: ChildFactory;
  private readonly maxChildren: number;
  private readonly idleTimeoutMs: number;
  private readonly log: PoolLogger;

  /**
   * Live children keyed by composite conversation id. The iteration order of a
   * Map is insertion order, so this also serves as the LRU ordering: we move
   * an entry to the end (delete + re-set) on every lease acquisition to keep
   * the least-recently-used entry at the front.
   */
  private readonly entries = new Map<string, PoolEntry>();

  /**
   * In-flight child creation promises keyed by conversation id, preventing
   * duplicate concurrent spawns for the same conversation. Two concurrent
   * `acquire` calls for the same `(adapterId, conversationKey)` share one
   * creation promise.
   */
  private readonly inflight = new Map<string, Promise<PoolEntry>>();

  /** FIFO queue of waiters blocked at capacity. */
  private readonly waiters: Waiter[] = [];

  private closed = false;

  /**
   * Number of in-flight child creations that will occupy a capacity slot on
   * completion but have not yet been inserted into `entries`. This counter
   * prevents over-allocation: capacity is `maxChildren - entries.size -
   * pendingCreations - closing`.
   */
  private pendingCreations = 0;

  /**
   * Number of children currently in the process of closing (capacity eviction
   * or idle sweep). Their slot is occupied until `child.close()` confirms
   * exit, preventing N+1 live OS children.
   */
  private closing = 0;
  /**
   * Teardowns started by eviction. Entries removed before an asynchronous
   * idle sweep finishes are not present in `entries`, so close must await this
   * set separately before releasing the registry's remaining ownership.
   */
  private readonly pendingEvictions = new Set<Promise<unknown>>();

  /** Shared completion promise for concurrent, idempotent close calls. */
  private closePromise: Promise<void> | null = null;

  /** Single capacity eviction used by FIFO waiter draining. */
  private drainEviction: Promise<void> | null = null;

  constructor(options: PoolManagerOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("PoolManagerOptions is required");
    }
    if (!options.registry) {
      throw new Error("PoolManagerOptions.registry is required");
    }
    if (typeof options.factory !== "function") {
      throw new Error("PoolManagerOptions.factory is required");
    }
    if (!Number.isSafeInteger(options.maxChildren) || options.maxChildren < 1) {
      throw new Error(
        "PoolManagerOptions.maxChildren must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(options.idleTimeoutMs) ||
      options.idleTimeoutMs < 1
    ) {
      throw new Error(
        "PoolManagerOptions.idleTimeoutMs must be a positive integer",
      );
    }
    if (typeof options.logger !== "function") {
      throw new Error("PoolManagerOptions.logger is required");
    }

    this.registry = options.registry;
    this.factory = options.factory;
    this.maxChildren = options.maxChildren;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.log = options.logger;
  }

  // ---- acquire / lease ----

  /**
   * Acquire a leased child for `(adapterId, conversationKey)`.
   *
   * If a live child already exists for this conversation, it is reused and its
   * lease is marked in use. If no live child exists but the registry has a
   * mapping, a fresh child is created via the factory and attached to the
   * stored session file (`getOrCreate` + `switchSession`). If no mapping
   * exists, a new session is created and the child is attached.
   *
   * When the pool is at capacity:
   *   - If an idle (not-in-use) child exists, the least-recently-used one is
   *     evicted (closed and removed) to make room. The eviction awaits child
   *     close before the new creation begins, preventing N+1 live children.
   *   - If all children are in use, the caller enters a FIFO wait queue and
   *     resolves once a lease is released.
   *
   * The returned {@link Lease} must be released exactly once; double-release
   * is a safe no-op. Never resolves after the manager is closed: a pending
   * waiter is rejected with {@link PoolClosedError}.
   */
  async acquire(adapterId: string, conversationKey: string): Promise<Lease> {
    if (!adapterId) throw new Error("adapterId is required");
    if (!conversationKey) throw new Error("conversationKey is required");
    if (this.closed) throw new PoolClosedError();

    const id = conversationIdOf(adapterId, conversationKey);

    // A live child already exists for this conversation. If it is idle,
    // lease it immediately. If it is in use, enqueue a waiter so the caller
    // gets the lease when the current holder releases it.
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.retiring) {
        throw new Error(
          `child for adapter="${adapterId}" key="${conversationKey}" is retiring`,
        );
      }
      if (!existing.inUse) {
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        this.touchLru(id);
        existing.inUse = true;
        this.registry.touch(adapterId, conversationKey);
        return this.makeLease(existing);
      }
      // Entry is in use: wait for it to be released.
      return this.enqueueWaiter(adapterId, conversationKey);
    }

    // A creation may already be in flight for this conversation; await it.
    // The in-flight guard prevents duplicate concurrent spawns. After it
    // resolves, the entry will be in `entries`; if it is already in use
    // (handed to another waiter), enqueue.
    const inflight = this.inflight.get(id);
    if (inflight) {
      const entry = await inflight;
      if (this.closed) throw new PoolClosedError();
      if (!entry.inUse) {
        entry.inUse = true;
        this.touchLru(id);
        this.registry.touch(adapterId, conversationKey);
        return this.makeLease(entry);
      }
      return this.enqueueWaiter(adapterId, conversationKey);
    }

    // We need to create a new child. Check capacity first. Account for
    // in-flight creations and closing children that still occupy a slot.
    if (this.occupiedSlots() >= this.maxChildren) {
      const ev = await this.evictIdleForCapacity();
      if (!ev.ok) {
        if (ev.reason === "close_failed") {
          // Eviction found idle children but every close attempt failed; each
          // was restored as an occupied idle slot, so the caller's conversation
          // cannot be created and the slot will not free without a release.
          // Throw the preserved close error rather than enqueueing behind a
          // restored idle entry with no future drain trigger (which would
          // strand the caller indefinitely).
          throw ev.error;
        }
        // All children are in use: enqueue a FIFO waiter.
        return this.enqueueWaiter(adapterId, conversationKey);
      }
    }

    if (this.closed) throw new PoolClosedError();
    // Create the child (and the registry mapping if needed).
    const entry = await this.createEntry(adapterId, conversationKey, id);
    if (this.closed) {
      // Pool was closed while we were creating. close() is responsible for
      // tearing down all entries and in-flight results; we must not
      // double-teardown. Just reject the caller.
      throw new PoolClosedError();
    }
    entry.inUse = true;
    this.touchLru(id);
    this.registry.touch(adapterId, conversationKey);
    return this.makeLease(entry);
  }

  /**
   * Remove a child that exited outside normal pool teardown. The dead process
   * no longer occupies capacity, and stale ownership must not make a later
   * acquire reuse it.
   */
  forgetExitedChild(
    adapterId: string,
    conversationKey: string,
    child: RpcChild,
  ): void {
    const id = conversationIdOf(adapterId, conversationKey);
    const entry = this.entries.get(id);
    if (!entry || entry.child !== child) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.entries.delete(id);

    const releaseError = this.releaseOwnership(entry);
    if (releaseError) {
      this.log({
        type: "ownership_release_failed",
        adapterId,
        conversationKey,
        message: `exited child ownership release failed: ${releaseError.message}`,
      });
    } else {
      this.log({
        type: "child_closed",
        adapterId,
        conversationKey,
        size: this.entries.size,
        message: "exited child removed and ownership released",
      });
    }

    this.drainWaiters();
  }

  /**
   * Remove and close a known-bad child before its lease is released, keeping
   * its capacity slot occupied until process exit is confirmed.
   */
  async retireChild(
    adapterId: string,
    conversationKey: string,
    child: RpcChild,
  ): Promise<void> {
    const id = conversationIdOf(adapterId, conversationKey);
    const entry = this.entries.get(id);
    if (!entry || entry.child !== child || entry.retiring) return;
    entry.retiring = true;
    entry.inUse = false;
    const outcome = await this.evictEntrySync(id, entry, "capacity");
    if (!outcome.ok && outcome.reason === "close_failed") {
      entry.inUse = true;
      this.rejectWaitersFor(id, outcome.error);
      throw outcome.error;
    }
    this.drainWaiters();
  }

  // ---- stats / observability ----

  /** Observable snapshot of pool state. */
  stats(): PoolStats {
    let active = 0;
    for (const entry of this.entries.values()) {
      if (entry.inUse) active++;
    }
    return {
      size: this.entries.size,
      activeLeases: active,
      idle: this.entries.size - active,
      waiters: this.waiters.length,
      closing: this.closing,
      maxChildren: this.maxChildren,
    };
  }

  // ---- close ----

  /**
   * Close the pool. All live children are closed and their registry ownership
   * released. Pending waiters are rejected with {@link PoolClosedError}
   * deterministically (in queue order). In-flight creations are awaited and
   * any child they produce is closed before this method resolves. The owned
   * {@link SessionRegistry} is NOT closed. Safe to call multiple times.
   *
   * @throws {@link PoolCloseError} if any child close or ownership release
   *   failed. Individual errors are aggregated on the `errors` property.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  private async closeImpl(): Promise<void> {
    // Cancel all pending waiters deterministically in FIFO order.
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(new PoolClosedError());
      this.log({
        type: "wait_cancelled",
        adapterId: w.adapterId,
        conversationKey: w.conversationKey,
        waiters: this.waiters.length,
        message: "waiter cancelled on close",
      });
    }

    const errors: Error[] = [];

    // Stop idle callbacks before the first await. Entries already removed by
    // an idle callback are tracked in pendingEvictions and awaited below.
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
    }

    // Await all in-flight creations. When they resolve, doCreate adds the
    // entry to `this.entries` synchronously.
    const inflightPromises = [...this.inflight.values()];
    await Promise.allSettled(inflightPromises);
    this.inflight.clear();
    this.pendingCreations = 0;

    // Idle evictions remove entries before their asynchronous child close and
    // ownership release settle. Preserve any failure for the caller.
    errors.push(...(await this.waitForPendingEvictions()));

    // Close all live children and release ownership.
    const teardownPromises: Promise<TeardownResult>[] = [];
    for (const entry of this.entries.values()) {
      teardownPromises.push(this.teardownEntry(entry));
    }
    this.entries.clear();

    const teardownResults = await Promise.allSettled(teardownPromises);
    for (const r of teardownResults) {
      if (r.status === "rejected") {
        errors.push(
          r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
        );
      } else if (r.value.error) {
        errors.push(r.value.error);
      }
    }

    if (errors.length > 0) {
      throw new PoolCloseError(errors);
    }
  }

  /**
   * Close all idle children immediately, leaving in-use children running. Does
   * not touch waiters. Each idle child is closed before its ownership is
   * released. Returns the number of children closed.
   */
  async closeIdle(): Promise<number> {
    let closed = 0;
    const toClose: PoolEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.inUse) {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        toClose.push(entry);
      }
    }
    for (const entry of toClose) {
      const id = conversationIdOf(entry.adapterId, entry.conversationKey);
      if (this.entries.get(id) !== entry || entry.inUse) continue;
      this.entries.delete(id);
      this.closing++;
      const result = await this.trackEviction(this.teardownEntry(entry));
      this.closing--;
      if (result.stage === "close_failed") {
        // Child may still be alive: restore as occupied idle slot.
        entry.inUse = false;
        entry.idleTimer = null;
        this.entries.set(id, entry);
        // Do not count as closed.
      } else {
        closed++;
      }
    }
    this.drainWaiters();
    return closed;
  }

  // ---- internals: creation ----

  /**
   * Create a {@link PoolEntry} for a conversation: spawn a child via the
   * factory, resolve or create the registry mapping, claim ownership via CAS,
   * and insert into the pool. The in-flight guard prevents duplicate spawns.
   */
  private async createEntry(
    adapterId: string,
    conversationKey: string,
    id: string,
  ): Promise<PoolEntry> {
    // Deduplicate concurrent creation for the same conversation.
    const existing = this.inflight.get(id);
    if (existing) return existing;

    this.pendingCreations++;
    const promise = this.doCreate(adapterId, conversationKey, id).finally(
      () => {
        this.inflight.delete(id);
        this.pendingCreations--;
      },
    );
    this.inflight.set(id, promise);
    return promise;
  }

  private async doCreate(
    adapterId: string,
    conversationKey: string,
    id: string,
  ): Promise<PoolEntry> {
    // 1. Spawn a fresh child through the injected factory.
    let child: RpcChild;
    try {
      child = await this.factory({
        adapterId,
        conversationKey,
        registryKey: id,
      });
    } catch (err) {
      this.log({
        type: "create_failed",
        adapterId,
        conversationKey,
        message: `factory failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    // 2. Resolve or create the registry mapping. getOrCreate attaches the
    //    child to the stored session file via switchSession internally, or
    //    creates a new session if none exists. On any failure, close the
    //    freshly spawned child.
    let record;
    try {
      record = await this.registry.getOrCreate(
        child,
        adapterId,
        conversationKey,
      );
    } catch (err) {
      await this.closeChildOrThrow(child, adapterId, conversationKey);
      this.log({
        type: "create_failed",
        adapterId,
        conversationKey,
        message: `getOrCreate failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    // 3. Claim ownership via compare-and-set. If the row has a stale owner
    //    (leftover from a crashed previous supervisor), the startup-sweep
    //    contract permits a CAS transfer from that recorded owner to our new
    //    token. Try the null-owner acquire first; on OwnerMismatchError,
    //    attempt a transfer from the recorded stale owner. Any other error
    //    (not OwnerMismatchError) is surfaced, not swallowed.
    const ownerToken = randomUUID();
    try {
      this.registry.setOwner(adapterId, conversationKey, null, ownerToken);
    } catch (err) {
      if (!(err instanceof OwnerMismatchError)) {
        await this.closeChildOrThrow(child, adapterId, conversationKey);
        this.log({
          type: "create_failed",
          adapterId,
          conversationKey,
          message: `setOwner failed (non-owner-mismatch): ${err instanceof Error ? err.message : String(err)}`,
        });
        throw err;
      }
      // OwnerMismatchError: a stale owner is recorded. Attempt transfer.
      const record2 = this.registry.get(adapterId, conversationKey);
      const staleOwner = record2?.currentOwner ?? null;
      if (staleOwner !== null) {
        this.log({
          type: "revival",
          adapterId,
          conversationKey,
          message: `transferring ownership from stale owner ${staleOwner}`,
        });
        try {
          this.registry.setOwner(
            adapterId,
            conversationKey,
            staleOwner,
            ownerToken,
          );
        } catch (err2) {
          if (!(err2 instanceof OwnerMismatchError)) {
            await this.closeChildOrThrow(child, adapterId, conversationKey);
            this.log({
              type: "create_failed",
              adapterId,
              conversationKey,
              message: `stale-owner transfer failed (non-owner-mismatch): ${err2 instanceof Error ? err2.message : String(err2)}`,
            });
            throw err2;
          }
          // OwnerMismatchError on transfer: someone else changed ownership
          // between our get and set. Close the child and surface.
          await this.closeChildOrThrow(child, adapterId, conversationKey);
          this.log({
            type: "create_failed",
            adapterId,
            conversationKey,
            message: "ownership changed during stale-owner transfer",
          });
          throw new Error(
            `could not claim ownership for adapter="${adapterId}" key="${conversationKey}" (owner changed during transfer)`,
          );
        }
      } else {
        // currentOwner is null but setOwner threw OwnerMismatchError: the
        // row was deleted between get and set. Close and surface.
        await this.closeChildOrThrow(child, adapterId, conversationKey);
        this.log({
          type: "create_failed",
          adapterId,
          conversationKey,
          message: "registry row disappeared during ownership claim",
        });
        throw new Error(
          `registry row disappeared for adapter="${adapterId}" key="${conversationKey}"`,
        );
      }
    }

    this.log({
      type: "revival",
      adapterId,
      conversationKey,
      message: `revived session ${record.sessionFile}`,
    });

    const entry: PoolEntry = {
      child,
      adapterId,
      conversationKey,
      ownerToken,
      inUse: false,
      retiring: false,
      lastUsedAt: Date.now(),
      idleTimer: null,
    };

    this.entries.set(id, entry);
    return entry;
  }

  // ---- internals: lease ----

  private makeLease(entry: PoolEntry): Lease {
    const id = conversationIdOf(entry.adapterId, entry.conversationKey);
    let released = false;
    return {
      child: entry.child,
      adapterId: entry.adapterId,
      conversationKey: entry.conversationKey,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(id);
      },
    };
  }

  /**
   * Release a lease: mark the entry idle, advance lastUsedAt, touch the
   * registry last-active, arm the idle timer, and drain the next waiter if
   * capacity allows.
   */
  private releaseEntry(id: string): void {
    if (this.closed) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.retiring) return;
    entry.inUse = false;
    entry.lastUsedAt = Date.now();
    this.touchLru(id);
    this.registry.touch(entry.adapterId, entry.conversationKey);
    this.armIdleTimer(entry);

    // If there are waiters and we now have capacity, resolve the head.
    this.drainWaiters();
  }

  // ---- internals: eviction ----

  /**
   * Total slots occupied: live entries plus pending creations plus children
   * in the process of closing. Used for capacity checks.
   */
  private occupiedSlots(): number {
    return this.entries.size + this.pendingCreations + this.closing;
  }

  /**
   * Evict idle children to make room for a new creation, trying candidates in
   * LRU order. Awaits child close before returning so the OS child is confirmed
   * dead before the new one spawns; the `closing` counter is incremented during
   * each close so capacity accounting stays correct.
   *
   * - `{ ok: true }`: an idle child was evicted (slot freed).
   * - `{ ok: false, reason: "all_in_use" }`: no idle child exists to evict.
   * - `{ ok: false, reason: "close_failed", error }`: idle children were found
   *   but every close attempt failed. Each was restored as an occupied idle
   *   slot; the carried `error` is the preserved close error so the caller can
   *   surface it instead of enqueueing behind a slot that will never drain.
   *
   * Never evicts an in-use child.
   */
  private async evictIdleForCapacity(): Promise<EvictForCapacityOutcome> {
    // Snapshot idle candidates in LRU order before any async close so a
    // restored (close-failed) entry is not revisited during iteration.
    const idle: Array<[string, PoolEntry]> = [];
    for (const [id, entry] of this.entries) {
      if (!entry.inUse) idle.push([id, entry]);
    }

    if (idle.length === 0) {
      this.log({
        type: "cap_reached",
        size: this.entries.size,
        waiters: this.waiters.length,
        message: `pool at capacity (${this.occupiedSlots()}/${this.maxChildren}); all in use`,
      });
      return { ok: false, reason: "all_in_use" };
    }

    let closeError: Error | undefined;
    for (const [id, entry] of idle) {
      // A concurrent acquirer may lease the entry between the snapshot and
      // now; only evict if it is still present and idle.
      const current = this.entries.get(id);
      if (!current || current !== entry || current.inUse) continue;
      const outcome = await this.evictEntrySync(id, entry, "capacity");
      if (outcome.ok) return { ok: true };
      if (outcome.reason === "unavailable") continue;
      // Close failed: entry restored as an occupied idle slot. Preserve the
      // error and try the next candidate so a viable eviction is not rejected
      // on the strength of one failed child.
      closeError = outcome.error;
    }

    if (closeError) {
      this.log({
        type: "cap_reached",
        size: this.entries.size,
        waiters: this.waiters.length,
        message: `eviction close failed for all idle children; cannot free slot (${this.occupiedSlots()}/${this.maxChildren})`,
      });
      return { ok: false, reason: "close_failed", error: closeError };
    }
    if (this.occupiedSlots() < this.maxChildren) return { ok: true };
    this.log({
      type: "cap_reached",
      size: this.entries.size,
      waiters: this.waiters.length,
      message: `pool at capacity (${this.occupiedSlots()}/${this.maxChildren}); all candidates were claimed`,
    });
    return { ok: false, reason: "all_in_use" };
  }

  /**
   * Asynchronous eviction for idle-sweep timers. Removes the entry from the
   * pool immediately but increments `closing` so the slot stays occupied
   * until close completes. On close failure, restores the entry as an
   * occupied idle slot (ownership retained). On release failure after
   * confirmed exit, the slot is freed and the failure is logged.
   */
  private evictEntryAsync(
    id: string,
    entry: PoolEntry,
    reason: "capacity" | "idle",
  ): void {
    if (this.entries.get(id) !== entry || entry.inUse) return;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.entries.delete(id);
    this.closing++;

    this.log({
      type: "eviction",
      adapterId: entry.adapterId,
      conversationKey: entry.conversationKey,
      size: this.entries.size,
      message: `evicted (${reason})`,
    });

    const eviction = this.trackEviction(
      this.teardownEntry(entry)
        .then((result) => {
          if (result.stage === "close_failed") {
            // Child may still be alive: restore as occupied idle slot.
            entry.inUse = false;
            entry.idleTimer = null;
            this.entries.set(id, entry);
          }
          if (result.error) throw result.error;
        })
        .finally(() => {
          this.closing--;
          this.drainWaiters();
        }),
    );
    void eviction.catch(() => {});
  }

  /**
   * Synchronous eviction: closes the child and releases ownership before
   * returning. Used by capacity eviction to prevent N+1 live children. The
   * `closing` counter is incremented during the operation.
   *
   * Returns `{ ok: true }` if the entry was successfully evicted (child closed
   * and ownership released, or child dead with a release failure that is
   * logged). Returns `{ ok: false, error }` if child close failed: the entry
   * is restored to `entries` as an occupied idle slot with ownership retained,
   * the `closing` counter is decremented so the slot is counted via
   * `entries.size` instead, and the preserved close `error` is carried so the
   * caller can surface it deterministically.
   */
  private async evictEntrySync(
    id: string,
    entry: PoolEntry,
    reason: "capacity" | "idle",
  ): Promise<EvictOutcome> {
    if (this.entries.get(id) !== entry || entry.inUse) {
      return { ok: false, reason: "unavailable" };
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.entries.delete(id);
    this.closing++;

    this.log({
      type: "eviction",
      adapterId: entry.adapterId,
      conversationKey: entry.conversationKey,
      size: this.entries.size,
      message: `evicted (${reason})`,
    });

    const result = await this.trackEviction(this.teardownEntry(entry));

    if (result.stage === "close_failed") {
      // Child may still be alive: restore the entry as an occupied idle
      // slot. Ownership is retained so startup sweep can recover.
      entry.inUse = false;
      entry.idleTimer = null;
      this.entries.set(id, entry);
      this.closing--;
      return { ok: false, reason: "close_failed", error: result.error! };
    }

    this.closing--;

    if (result.stage === "release_failed") {
      // Child is dead but release failed. Slot is free (child is gone).
      // Surface the failure but do not restore the entry.
      this.log({
        type: "ownership_release_failed",
        adapterId: entry.adapterId,
        conversationKey: entry.conversationKey,
        message: `eviction release failed: ${result.error!.message}`,
      });
    }

    return { ok: true };
  }

  // ---- internals: idle sweep ----

  private armIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    const id = conversationIdOf(entry.adapterId, entry.conversationKey);
    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(id);
      if (current && !current.inUse) {
        this.evictEntryAsync(id, current, "idle");
        this.log({
          type: "idle_sweep",
          adapterId: entry.adapterId,
          conversationKey: entry.conversationKey,
          size: this.entries.size,
          message: `idle child swept after ${this.idleTimeoutMs}ms`,
        });
      }
    }, this.idleTimeoutMs);
    // Do not keep the event loop alive solely for idle sweep timers.
    entry.idleTimer.unref?.();
  }

  // ---- internals: wait queue ----

  private enqueueWaiter(
    adapterId: string,
    conversationKey: string,
  ): Promise<Lease> {
    const { promise, resolve, reject } = Promise.withResolvers<Lease>();
    this.waiters.push({
      adapterId,
      conversationKey,
      resolve,
      reject,
    });
    this.log({
      type: "wait_enqueued",
      adapterId,
      conversationKey,
      size: this.entries.size,
      waiters: this.waiters.length,
      message: `enqueued at capacity (${this.occupiedSlots()}/${this.maxChildren})`,
    });
    return promise;
  }

  private rejectWaitersFor(id: string, error: Error): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!;
      if (conversationIdOf(waiter.adapterId, waiter.conversationKey) !== id) {
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.reject(error);
    }
  }

  /**
   * Drain the FIFO wait queue: for each waiter at the head, if capacity is
   * available, create/revive a child and resolve the waiter. Stops when the
   * queue is empty or capacity is exhausted again.
   */
  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      const id = conversationIdOf(waiter.adapterId, waiter.conversationKey);

      // If a live, idle child exists for this conversation, hand it over.
      // This does not consume a new capacity slot.
      const existing = this.entries.get(id);
      if (existing?.retiring) {
        this.waiters.shift();
        waiter.reject(
          new Error(
            `child for adapter="${waiter.adapterId}" key="${waiter.conversationKey}" is retiring`,
          ),
        );
        continue;
      }
      if (existing && !existing.inUse) {
        this.waiters.shift();
        existing.inUse = true;
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        this.touchLru(id);
        this.registry.touch(waiter.adapterId, waiter.conversationKey);
        waiter.resolve(this.makeLease(existing));
        this.log({
          type: "wait_resolved",
          adapterId: waiter.adapterId,
          conversationKey: waiter.conversationKey,
          waiters: this.waiters.length,
          message: "waiter resolved via reuse",
        });
        continue;
      }

      // A live child exists but is in use: do not create a second child for
      // the same conversation. Stop draining; the release will re-drain.
      if (existing && existing.inUse) break;

      // An in-flight creation exists for this conversation: the slot is
      // already reserved (pendingCreations was incremented). Await it and
      // hand the lease to this waiter if the entry is idle. No new slot is
      // consumed. Break after detaching: the async callback will re-drain.
      const inflight = this.inflight.get(id);
      if (inflight) {
        this.waiters.shift();
        inflight
          .then((entry) => {
            if (this.closed) {
              waiter.reject(new PoolClosedError());
              return;
            }
            if (!entry.inUse) {
              entry.inUse = true;
              this.touchLru(id);
              this.registry.touch(waiter.adapterId, waiter.conversationKey);
              waiter.resolve(this.makeLease(entry));
              this.log({
                type: "wait_resolved",
                adapterId: waiter.adapterId,
                conversationKey: waiter.conversationKey,
                waiters: this.waiters.length,
                message: "waiter resolved via in-flight creation",
              });
            } else {
              // Entry was already handed to another caller; re-enqueue.
              this.waiters.unshift({
                adapterId: waiter.adapterId,
                conversationKey: waiter.conversationKey,
                resolve: waiter.resolve,
                reject: waiter.reject,
              });
            }
            this.drainWaiters();
          })
          .catch((err) => {
            waiter.reject(err);
            this.drainWaiters();
          });
        break;
      }

      // No existing child and no in-flight creation. Check capacity before
      // creating; if none available, try evicting an idle child to make room.
      // If all are in use, stop draining until a release makes one idle.
      if (this.occupiedSlots() >= this.maxChildren) {
        const hasIdle = [...this.entries.values()].some(
          (entry) => !entry.inUse,
        );
        if (!hasIdle) return;
        if (!this.drainEviction) {
          const eviction = this.tryEvictForDrain().finally(() => {
            if (this.drainEviction === eviction) {
              this.drainEviction = null;
              this.drainWaiters();
            }
          });
          this.drainEviction = eviction;
          void eviction.catch(() => {});
        }
        return;
      }

      this.waiters.shift();
      this.createEntry(waiter.adapterId, waiter.conversationKey, id)
        .then((entry) => {
          if (this.closed) {
            // close() handles teardown of all entries and in-flight results.
            waiter.reject(new PoolClosedError());
            return;
          }
          entry.inUse = true;
          this.touchLru(id);
          this.registry.touch(waiter.adapterId, waiter.conversationKey);
          waiter.resolve(this.makeLease(entry));
          this.log({
            type: "wait_resolved",
            adapterId: waiter.adapterId,
            conversationKey: waiter.conversationKey,
            waiters: this.waiters.length,
            message: "waiter resolved via new creation",
          });
          this.drainWaiters();
        })
        .catch((err) => {
          waiter.reject(err);
          this.drainWaiters();
        });
      break;
    }
  }

  /**
   * Attempt to evict an idle child to free a capacity slot for the head
   * waiter. Runs asynchronously and re-drains on completion. If the close
   * fails, the affected head waiter is rejected with the preserved close
   * error so the caller sees the failure deterministically; the entry is
   * restored as an occupied idle slot by evictEntrySync. Draining then
   * continues so remaining waiters can retry via re-drain (reusing the
   * restored idle entry or triggering another eviction) and none strand.
   */
  private async tryEvictForDrain(): Promise<void> {
    const outcome = await this.evictIdleForCapacity();
    if (outcome.ok || outcome.reason !== "close_failed") return;

    // No idle child could be closed, so none of the current waiters can make
    // progress. Reject them deterministically rather than retrying forever.
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(outcome.error);
      this.log({
        type: "wait_cancelled",
        adapterId: waiter.adapterId,
        conversationKey: waiter.conversationKey,
        waiters: this.waiters.length,
        message: "waiter rejected: every idle child failed to close",
      });
    }
  }

  // ---- internals: LRU ----

  /**
   * Move an entry to the end of the Map (most-recently-used position) by
   * deleting and re-inserting. Map iteration order is insertion order, so the
   * front is the LRU entry.
   */
  private touchLru(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /** Track teardown work whose entry has already left the live map. */
  private trackEviction<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => {
      this.pendingEvictions.delete(tracked);
    });
    this.pendingEvictions.add(tracked);
    return tracked;
  }

  /** Drain pending evictions and return every failure observed while waiting. */
  private async waitForPendingEvictions(): Promise<Error[]> {
    const errors: Error[] = [];
    while (this.pendingEvictions.size > 0) {
      const results = await Promise.allSettled(this.pendingEvictions);
      for (const result of results) {
        if (result.status === "rejected") errors.push(asError(result.reason));
      }
    }
    return errors;
  }

  // ---- internals: teardown ----

  /**
   * Teardown an entry: close the child first, then CAS-release registry
   * ownership. Returns a stage-aware {@link TeardownResult} so the caller
   * can decide whether to restore the entry as an occupied idle slot
   * (close failed, child may still be alive) or free the slot (child dead).
   *
   * - Close failure: ownership retained, returns `{ stage: "close_failed",
   *   error }`. The child may still be alive; the entry must be restored.
   * - Release failure after confirmed exit: child is dead, returns
   *   `{ stage: "release_failed", error }`. The slot is free but the
   *   failure is surfaced for aggregation.
   * - Success: returns `{ stage: "child_closed" }`.
   */
  private async teardownEntry(entry: PoolEntry): Promise<TeardownResult> {
    const closeErr = await this.closeChild(entry);
    if (closeErr) {
      this.log({
        type: "ownership_retained",
        adapterId: entry.adapterId,
        conversationKey: entry.conversationKey,
        message: `child close failed; ownership retained: ${closeErr.message}`,
      });
      return { stage: "close_failed", error: closeErr };
    }

    // Child closed successfully: CAS-release ownership.
    const releaseErr = this.releaseOwnership(entry);
    if (releaseErr) {
      this.log({
        type: "ownership_release_failed",
        adapterId: entry.adapterId,
        conversationKey: entry.conversationKey,
        message: `child closed but ownership release failed: ${releaseErr.message}`,
      });
      return { stage: "release_failed", error: releaseErr };
    }

    this.log({
      type: "child_closed",
      adapterId: entry.adapterId,
      conversationKey: entry.conversationKey,
      size: this.entries.size,
      message: "child closed and ownership released",
    });
    return { stage: "child_closed" };
  }

  /**
   * Close a child process. Returns an Error on failure (does not throw) so
   * the caller can decide whether to retain ownership.
   */
  private async closeChild(entry: PoolEntry): Promise<Error | null> {
    try {
      await entry.child.close();
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Close a freshly spawned child that failed during creation. Throws a
   * combined error if both the close and the original issue need surfacing.
   */
  private async closeChildOrThrow(
    child: RpcChild,
    adapterId: string,
    conversationKey: string,
  ): Promise<void> {
    try {
      await child.close();
    } catch (closeErr) {
      this.log({
        type: "create_failed",
        adapterId,
        conversationKey,
        message: `cleanup close also failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      });
      throw closeErr instanceof Error ? closeErr : new Error(String(closeErr));
    }
  }

  /**
   * CAS-release registry ownership for an entry. Returns an Error on failure
   * (does not throw) so the caller can aggregate.
   */
  private releaseOwnership(entry: PoolEntry): Error | null {
    try {
      this.registry.release(
        entry.adapterId,
        entry.conversationKey,
        entry.ownerToken,
      );
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const conversationIdOf = conversationStorageKey;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
