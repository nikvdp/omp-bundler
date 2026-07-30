/**
 * Atomic process-group registry and crash-recovery sweep for RpcChild.
 *
 * Each RpcChild is spawned in its own Unix process group (pgid == child pid
 * via `detached: true`). The supervisor persists owned pgids in an
 * explicitly-supplied JSON registry file so that, after a crash, a fresh
 * supervisor process can reclaim exactly those process groups without ever
 * scanning host processes by name.
 *
 * Registry file format: a single JSON object mapping opaque conversation keys
 * (namespaced by adapter id) to {@link ChildRegistryEntry}. Writes are atomic
 * (temp file in the same directory, then `rename`), so a crash mid-write
 * never leaves a truncated registry.
 *
 * Platform contract:
 * - Process-group kill and the startup sweep are Unix-only. On non-Unix
 *   platforms they throw {@link UnsupportedPlatformError} rather than
 *   silently no-op; never pretend a group was torn down.
 * - Registry file I/O (read/write/register/unregister) is plain JSON and
 *   works on any platform; only the signal-bearing operations are gated.
 *
 * Concurrency: all read-modify-write operations (register, unregister, sweep)
 * on a given registry path are serialized through an in-process promise chain
 * ({@link withRegistryLock}) so concurrent child starts within one supervisor
 * never lose entries. Cross-process coordination requires one registry path
 * per supervisor.
 *
 * Failure mode: a corrupt or structurally invalid registry file fails loudly
 * (throws) at read time. Only a genuinely absent file (ENOENT) returns an
 * empty registry. This prevents silently leaking live process groups.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** True on Unix-like systems where process groups and negative-pgid kills work. */
export const IS_UNIX = process.platform !== "win32";

/** Thrown when a Unix-only operation (group kill / sweep) is invoked off-Unix. */
export class UnsupportedPlatformError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is unsupported on ${process.platform}: process-group ` +
        `teardown requires Unix signal semantics (negative pgid kill).`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A persisted registry entry for one owned child process group. */
export interface ChildRegistryEntry {
  /** Process group id. For a detached spawn this equals the child pid. */
  pgid: number;
  /** The child process pid (diagnostic; equals pgid for detached spawns). */
  pid: number;
  /** Epoch milliseconds when the entry was registered. */
  startedAt: number;
  /** Spawned binary (diagnostic). */
  binary?: string;
}

/** Registry: opaque conversation key -> entry. */
export type ChildRegistry = Record<string, ChildRegistryEntry>;

/** Result of a {@link sweepChildRegistry} pass. */
export interface SweepResult {
  /** Keys whose process group was alive and was reclaimed (SIGKILL'd). */
  reclaimed: string[];
  /** Keys whose process group was already gone; entry removed. */
  stale: string[];
  /** Keys whose group exists but could not be signalled (EPERM); entry left. */
  denied: string[];
}

// ---------------------------------------------------------------------------
// Per-path serialization
// ---------------------------------------------------------------------------

/**
 * In-process promise chain keyed by registry path. Every read-modify-write
 * (register, unregister, sweep) is queued through this so concurrent child
 * starts within one supervisor never interleave and lose entries.
 */
const registryLocks = new Map<string, Promise<void>>();

function withRegistryLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = registryLocks.get(path) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  // Chain a void wrapper so a rejection in one operation does not propagate
  // to (and abort) the next queued operation.
  registryLocks.set(
    path,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

// ---------------------------------------------------------------------------
// Registry file I/O (atomic)
// ---------------------------------------------------------------------------

/**
 * Read and parse the registry file.
 *
 * Returns `{}` only when the file is genuinely absent (ENOENT). A corrupt,
 * truncated, or structurally invalid registry throws: silently treating it
 * as empty would leak live process groups that the file is supposed to
 * account for. The caller (supervisor startup, sweep) must surface the error.
 */
export async function readChildRegistry(path: string): Promise<ChildRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `registry at ${path} contains corrupt JSON; refusing to start with ` +
        `live process groups unaccounted for`,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `registry at ${path} is not a JSON object; refusing to start`,
    );
  }
  const registry: ChildRegistry = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!isRegistryEntry(value)) {
      throw new Error(
        `registry at ${path} has an invalid entry for key "${key}"; ` +
          `refusing to start with live process groups unaccounted for`,
      );
    }
    registry[key] = value;
  }
  return registry;
}

/** Atomically overwrite the registry file with `registry`. */
export async function writeChildRegistry(
  path: string,
  registry: ChildRegistry,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
  // `rename` is atomic on the same filesystem; this is the durability boundary.
  await rename(tmp, path);
}

/**
 * Register a child's process group under `key`.
 *
 * Serialized per path via {@link withRegistryLock}. Rejects a key collision
 * unless the existing entry has the same pgid (idempotent re-registration).
 */
export async function registerChild(
  path: string,
  key: string,
  entry: ChildRegistryEntry,
): Promise<void> {
  await withRegistryLock(path, async () => {
    const registry = await readChildRegistry(path);
    const existing = registry[key];
    if (existing) {
      if (existing.pgid !== entry.pgid) {
        throw new Error(
          `registry key "${key}" is already registered with pgid ` +
            `${existing.pgid}; refusing to overwrite with pgid ${entry.pgid}`,
        );
      }
      // Idempotent: same pgid, already registered. Nothing to write.
      return;
    }
    registry[key] = entry;
    await writeChildRegistry(path, registry);
  });
}

/** Remove `key` from the registry. No-op if absent. Serialized per path. */
export async function unregisterChild(
  path: string,
  key: string,
): Promise<void> {
  await withRegistryLock(path, async () => {
    const registry = await readChildRegistry(path);
    if (!(key in registry)) return;
    delete registry[key];
    await writeChildRegistry(path, registry);
  });
}

// ---------------------------------------------------------------------------
// Process-group signalling (Unix only)
// ---------------------------------------------------------------------------

/**
 * Send `signal` to an entire process group by signalling the negative pgid.
 *
 * @returns `true` if the signal was delivered to the group, `false` if the
 *          group no longer exists (ESRCH).
 * @throws  {UnsupportedPlatformError} off-Unix.
 * @throws  if the caller lacks permission (EPERM), re-thrown so the caller
 *          can distinguish "gone" from "denied".
 */
export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals = "SIGKILL",
): boolean {
  if (!IS_UNIX) throw new UnsupportedPlatformError("killProcessGroup");
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`invalid pgid: ${pgid}`);
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // group already gone
    throw err; // EPERM etc. propagate
  }
}

/**
 * Check whether a process group is alive without sending a real signal.
 * @returns `true` if alive, `false` if gone (ESRCH). Throws on EPERM.
 */
export function processGroupAlive(pgid: number): boolean {
  if (!IS_UNIX) throw new UnsupportedPlatformError("processGroupAlive");
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`invalid pgid: ${pgid}`);
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Startup sweep
// ---------------------------------------------------------------------------

/**
 * Reclaim orphaned child process groups recorded in the registry and clear
 * stale entries, restart-safe.
 *
 * For every entry the sweep:
 *  - If the process group is gone (ESRCH): the entry is stale and removed.
 *  - If the group is alive: it is reclaimed with SIGKILL and the entry is
 *    removed.
 *  - If the group is alive but cannot be signalled (EPERM): the entry is left
 *    in the registry and reported as `denied`.
 *
 * The sweep reads ONLY the registry file; it never enumerates host processes
 * by name. On non-Unix platforms it throws {@link UnsupportedPlatformError}.
 * Serialized per path via {@link withRegistryLock} so a concurrent register or
 * unregister never interleaves with the sweep.
 *
 * @param path   Registry file path.
 * @param signal Reclamation signal (default SIGKILL for hard teardown).
 */
export async function sweepChildRegistry(
  path: string,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<SweepResult> {
  if (!IS_UNIX) throw new UnsupportedPlatformError("sweepChildRegistry");

  return withRegistryLock(path, async () => {
    const registry = await readChildRegistry(path);
    const reclaimed: string[] = [];
    const stale: string[] = [];
    const denied: string[] = [];

    for (const [key, entry] of Object.entries(registry)) {
      if (!Number.isSafeInteger(entry.pgid) || entry.pgid <= 0) {
        // Semantically invalid pgid: clear it restart-safely.
        stale.push(key);
        continue;
      }
      try {
        const alive = processGroupAlive(entry.pgid);
        if (!alive) {
          stale.push(key);
          continue;
        }
        // Group is alive: reclaim it.
        const delivered = killProcessGroup(entry.pgid, signal);
        if (delivered) {
          // Treated as reclaimed; the entry is removed so we don't loop.
          reclaimed.push(key);
        } else {
          stale.push(key);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          denied.push(key);
        } else {
          throw err;
        }
      }
    }

    // Rewrite the registry retaining only denied entries.
    const survivors: ChildRegistry = {};
    for (const key of denied) survivors[key] = registry[key];
    await writeChildRegistry(path, survivors);

    return { reclaimed, stale, denied };
  });
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

function isRegistryEntry(value: unknown): value is ChildRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pgid === "number" &&
    Number.isSafeInteger(v.pgid) &&
    typeof v.pid === "number" &&
    Number.isSafeInteger(v.pid) &&
    typeof v.startedAt === "number" &&
    (v.binary === undefined || typeof v.binary === "string")
  );
}
