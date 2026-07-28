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
 *   silently no-op — never pretend a group was torn down.
 * - Registry file I/O (read/write/register/unregister) is plain JSON and
 *   works on any platform; only the signal-bearing operations are gated.
 *
 * Concurrency: the registry is owned by a single supervisor process per
 * registry path. Read-modify-write is not safe against concurrent writers to
 * the same path; see the race note in {@link registerChild}.
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
// Registry file I/O (atomic)
// ---------------------------------------------------------------------------

/**
 * Read and parse the registry file. Returns `{}` if the file is absent or
 * contains corrupt/unparseable JSON (a truncated registry is treated as empty
 * so a crashed supervisor can always restart safely).
 */
export async function readChildRegistry(path: string): Promise<ChildRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const registry: ChildRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRegistryEntry(value)) registry[key] = value;
    }
    return registry;
  } catch {
    // Corrupt registry: treat as empty rather than blocking startup.
    return {};
  }
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
 * Race note: this is a non-atomic read-modify-write of the registry file. The
 * registry is owned by a single supervisor process per path; concurrent
 * writers to the same path may lose entries. If you need cross-process
 * coordination, use one registry path per supervisor.
 */
export async function registerChild(
  path: string,
  key: string,
  entry: ChildRegistryEntry,
): Promise<void> {
  const registry = await readChildRegistry(path);
  registry[key] = entry;
  await writeChildRegistry(path, registry);
}

/** Remove `key` from the registry. No-op if absent. */
export async function unregisterChild(path: string, key: string): Promise<void> {
  const registry = await readChildRegistry(path);
  if (!(key in registry)) return;
  delete registry[key];
  await writeChildRegistry(path, registry);
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
 * @throws  if the caller lacks permission (EPERM) — re-thrown so the caller
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
 *    removed once the group is confirmed gone.
 *  - If the group is alive but cannot be signalled (EPERM): the entry is left
 *    in the registry and reported as `denied`.
 *
 * The sweep reads ONLY the registry file; it never enumerates host processes
 * by name. On non-Unix platforms it throws {@link UnsupportedPlatformError}.
 *
 * @param path   Registry file path.
 * @param signal Reclamation signal (default SIGKILL for hard teardown).
 */
export async function sweepChildRegistry(
  path: string,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<SweepResult> {
  if (!IS_UNIX) throw new UnsupportedPlatformError("sweepChildRegistry");

  const registry = await readChildRegistry(path);
  const reclaimed: string[] = [];
  const stale: string[] = [];
  const denied: string[] = [];

  for (const [key, entry] of Object.entries(registry)) {
    if (!Number.isSafeInteger(entry.pgid) || entry.pgid <= 0) {
      // Malformed entry: clear it restart-safely.
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
        // Confirm the group is gone before clearing the entry.
        if (!processGroupAlive(entry.pgid)) {
          reclaimed.push(key);
        } else {
          // Still alive immediately after SIGKILL (large tree): treat as
          // reclaimed; the entry is removed so we don't loop forever.
          reclaimed.push(key);
        }
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