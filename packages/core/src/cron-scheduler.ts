/**
 * Cron scheduler runtime: an independent process that fires scheduled agent
 * prompts and writes the agent's output to a durable logs directory.
 *
 * This is NOT an adapter. It has no adapter registration, no inbound POST, no
 * Core HTTP path, and no outbound callback. It reuses the OMP `--mode rpc`
 * child machinery ({@link RpcChild}) the way the core supervisor does, but as
 * a standalone process: it spawns a child, runs a fresh session per job, sends
 * the job's prompt, captures the assistant text deltas, writes the run output
 * and a `last-run.json` to `/data/cron/jobs/<job-id>/`, then closes the child.
 *
 * Filesystem philosophy: schedules are source (`schedules/*.yml` at the bundle
 * root); cron output is durable runtime state under `/data/cron/` that the
 * agent itself can read to answer "what happened on the last cron run?".
 *
 * Lifecycle: `start()` begins a `setTimeout`-driven tick loop. `stop()` drains
 * any in-flight job and resolves. Re-scans `schedules/` on each wake so
 * added/edited jobs take effect without a restart.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcChild, type RpcEventFrame } from "./rpc-child.js";
import {
  parseCronExpression,
  nextRunAfter,
  type CronSchedule,
} from "./cron-expression.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cron job loaded from `schedules/*.yml`. */
export interface CronJob {
  /** Job id = the filename stem (e.g. `daily-summary`). */
  id: string;
  /** 5-field cron expression. */
  schedule: string;
  /** IANA timezone. Defaults to UTC. */
  timezone: string;
  /** Missed-tick policy. */
  missed: "skip" | "catchUp";
  /** The user message sent to the agent each run. */
  prompt: string;
  /** Parsed schedule, computed once after validation. */
  parsed: CronSchedule;
}

/** Result of one job run. */
interface RunResult {
  status: "ok" | "error";
  text: string;
  sessionFile: string | null;
  error: string | null;
  durationMs: number;
}

/** Injectable clock returning epoch milliseconds. */
export type Clock = () => number;

/** Injectable factory for an OMP RPC child (for tests). */
export type ChildFactory = (cwd: string) => Promise<RpcChild>;

/** Options for {@link startCronScheduler}. */
export interface CronSchedulerOptions {
  /** Directory holding `*.yml` schedule files. */
  schedulesDir: string;
  /** Durable output root, e.g. `/data/cron`. */
  cronDataDir: string;
  /** Workspace cwd for spawned OMP children. */
  workspaceDir: string;
  /** OMP binary to spawn. */
  ompBinary: string;
  /** OMP model id, or null. */
  ompModel: string | null;
  /** OMP profile name, or null. */
  ompProfile: string | null;
  /** Extra args after `--mode rpc`. */
  ompArgs: string[];
  /** Path to the ambient-ingest extension to load via `-e`. */
  ambientExtensionPath: string;
  /** Injectable clock (defaults to Date.now). */
  now?: Clock;
  /** Injectable child factory (defaults to spawning a real RpcChild). */
  childFactory?: ChildFactory;
}

/** A running scheduler handle. */
export interface CronScheduler {
  /** Begin the tick loop. Returns immediately. */
  start(): void;
  /** Stop the loop and wait for any in-flight job to finish. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum `setTimeout` delay cap, so newly-added schedules are picked up. */
const MAX_WAKE_MS = 60_000;
/** Cap catch-up fires per due job to avoid runaway catch-up. */
const CATCH_UP_CAP = 5;
/** Default ready/response timeouts for spawned children. */
const CHILD_READY_TIMEOUT_MS = 30_000;
const CHILD_RESPONSE_TIMEOUT_MS = 0; // 0 = wait indefinitely for long turns

// ---------------------------------------------------------------------------
// Schedule loading + parsing
// ---------------------------------------------------------------------------

/**
 * Load and validate every active `*.yml` schedule from `schedulesDir`. Files
 * ending in `.example` (and any other suffix) are inert and skipped. Throws on
 * a malformed schedule file so the caller can fail loudly at startup.
 */
export async function loadSchedules(schedulesDir: string): Promise<CronJob[]> {
  const names = await readdir(schedulesDir).catch(() => [] as string[]);
  const jobs: CronJob[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".yml")) continue; // inert: *.yml.example or unrelated
    const id = name.slice(0, -".yml".length);
    const path = join(schedulesDir, name);
    const source = await readFile(path, "utf8");
    const job = parseScheduleFile(id, source);
    jobs.push(job);
  }
  return jobs;
}

/** Parse one schedule YAML body into a validated {@link CronJob}. */
export function parseScheduleFile(id: string, source: string): CronJob {
  const parsed = parseYaml(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`schedule '${id}' must be a YAML mapping`);
  }
  const record = parsed as Record<string, unknown>;
  const schedule = requiredString(record, "schedule", id);
  const timezone = optionalString(record, "timezone", id) ?? "UTC";
  const missed = record.missed;
  if (missed !== "skip" && missed !== "catchUp") {
    throw new Error(`schedule '${id}': missed must be 'skip' or 'catchUp'`);
  }
  const prompt = requiredString(record, "prompt", id);
  if (prompt.trim().length === 0) {
    throw new Error(`schedule '${id}': prompt must be non-empty`);
  }
  validateTimezone(timezone, id);
  let cronSchedule: CronSchedule;
  try {
    cronSchedule = parseCronExpression(schedule);
  } catch (error) {
    throw new Error(
      `schedule '${id}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    id,
    schedule,
    timezone,
    missed,
    prompt,
    parsed: cronSchedule,
  };
}

function requiredString(record: Record<string, unknown>, field: string, id: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`schedule '${id}': ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, id: string): string | null {
  const value = record[field];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`schedule '${id}': ${field} must be a non-empty string`);
  }
  return value;
}

/** Throw if `tz` is not a valid IANA timezone Intl can format. */
function validateTimezone(tz: string, id: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`schedule '${id}': timezone '${tz}' is not a valid IANA timezone`);
  }
}

// ---------------------------------------------------------------------------
// Run-state persistence
// ---------------------------------------------------------------------------

/** Atomic write of `last-run.json` for a job. */
async function writeLastRun(
  cronDataDir: string,
  jobId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const dir = join(cronDataDir, "jobs", jobId);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "last-run.json.tmp");
  const final = join(dir, "last-run.json");
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, final);
}

/** Atomic write of one run's output text. */
async function writeRun(
  cronDataDir: string,
  jobId: string,
  fireEpoch: number,
  text: string,
): Promise<string> {
  const dir = join(cronDataDir, "jobs", jobId, "runs");
  await mkdir(dir, { recursive: true });
  const name = `${fireEpoch}.txt`;
  const tmp = join(dir, `${name}.tmp`);
  const final = join(dir, name);
  await writeFile(tmp, text, "utf8");
  await rename(tmp, final);
  return final;
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

/**
 * Spawn an OMP RPC child, create a fresh session, send the prompt, capture
 * assistant text deltas until `agent_end`, and return the run result. The
 * child is always closed in a finally block.
 */
export async function runJobOnce(
  job: CronJob,
  fireEpoch: number,
  options: CronSchedulerOptions,
): Promise<RunResult> {
  const startedAt = options.now?.() ?? Date.now();
  const cwd = options.workspaceDir;
  let child: RpcChild | null = null;
  let text = "";
  let sessionFile: string | null = null;
  let agentEnded = false;

  const args = buildChildArgs(options);
  const factory = options.childFactory ?? defaultChildFactory(options);

  const onEvent = (frame: RpcEventFrame) => {
    if (frame.type === "message_update") {
      text += extractDelta(frame) ?? "";
    } else if (frame.type === "agent_end") {
      agentEnded = true;
    }
  };
  // Install the turn-done listeners BEFORE prompt so an exit or agent_end
  // that fires while the prompt command is in flight is never missed.
  let childDone: { finish: () => void; onTurnEvent: (f: RpcEventFrame) => void; onTurnExit: () => void } | undefined;
  const turnDone = new Promise<void>((resolve) => {
    const finish = (): void => {
      child?.off("event", onTurnEvent);
      child?.off("exit", onTurnExit);
      resolve();
    };
    const onTurnEvent = (frame: RpcEventFrame): void => {
      if (frame.type === "agent_end") finish();
    };
    const onTurnExit = (): void => finish();
    childDone = { finish, onTurnEvent, onTurnExit };
  });

  try {
    child = await factory(cwd);
    child.on("event", onEvent);
    child.on("event", childDone!.onTurnEvent);
    child.on("exit", childDone!.onTurnExit);
    // v1 is fine for capturing text deltas; negotiate v2 for parity with the
    // supervisor's chunked-server handling on large payloads.
    await child.negotiateProtocolV2();
    const newRes = await child.newSession();
    if (!newRes.success) {
      throw new Error(`new_session failed: ${newRes.error ?? "unknown"}`);
    }
    const stateRes = await child.getState();
    if (stateRes.success && stateRes.data) {
      const sf = (stateRes.data as { sessionFile?: unknown }).sessionFile;
      if (typeof sf === "string") sessionFile = sf;
    }
    const promptRes = await child.prompt(job.prompt);
    if (!promptRes.success) {
      throw new Error(`prompt failed: ${promptRes.error ?? "unknown"}`);
    }
    await turnDone;
    if (!agentEnded) {
      throw new Error("agent ended without an agent_end frame");
    }
    return {
      status: "ok",
      text,
      sessionFile,
      error: null,
      durationMs: (options.now?.() ?? Date.now()) - startedAt,
    };
  } catch (error) {
    return {
      status: "error",
      text,
      sessionFile,
      error: error instanceof Error ? error.message : String(error),
      durationMs: (options.now?.() ?? Date.now()) - startedAt,
    };
  } finally {
    if (child) await child.close().catch(() => {});
    void args; // referenced for clarity; args are consumed by the factory
  }
}

/** Build the `--mode rpc` args the scheduler passes to RpcChild. */
function buildChildArgs(options: CronSchedulerOptions): string[] {
  const args: string[] = ["-e", options.ambientExtensionPath];
  if (options.ompModel) args.push("--model", options.ompModel);
  if (options.ompProfile) args.push("--profile", options.ompProfile);
  args.push("--cwd", options.workspaceDir);
  args.push(...options.ompArgs);
  return args;
}

/** Default factory: spawn a real OMP `--mode rpc` child. */
function defaultChildFactory(options: CronSchedulerOptions): ChildFactory {
  return async (cwd: string) => {
    const child = new RpcChild({
      binary: options.ompBinary,
      args: buildChildArgs(options),
      cwd,
      readyTimeoutMs: CHILD_READY_TIMEOUT_MS,
      responseTimeoutMs: CHILD_RESPONSE_TIMEOUT_MS,
    });
    await child.start();
    return child;
  };
}


/** Extract the text delta from a `message_update` frame (mirrors the emitter). */
function extractDelta(frame: RpcEventFrame): string | null {
  const ev = (frame as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  if (!ev || typeof ev !== "object") return null;
  const type = (ev as { type?: unknown }).type;
  if (type !== "text_delta") return null;
  const delta = (ev as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : null;
}

// ---------------------------------------------------------------------------
// Scheduler loop
// ---------------------------------------------------------------------------

/**
 * Start the cron scheduler tick loop. Returns a handle whose `stop()` drains
 * any in-flight run and resolves. The loop reschedules itself with
 * `setTimeout` at the soonest next fire time (clamped to {@link MAX_WAKE_MS}).
 */
export function startCronScheduler(
  options: CronSchedulerOptions,
): CronScheduler {
  const now = options.now ?? Date.now;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let jobs: CronJob[];
    try {
      jobs = await loadSchedules(options.schedulesDir);
    } catch (error) {
      console.error(
        `[cron] schedule load failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      scheduleNext(0);
      return;
    }
    if (jobs.length === 0) {
      scheduleNext(MAX_WAKE_MS);
      return;
    }
    const nowMs = now();
    // Track per-job lastRun on disk; load lazily into memory for this tick.
    let earliestNext = Number.POSITIVE_INFINITY;
    for (const job of jobs) {
      const lastRun = await readLastRun(options.cronDataDir, job.id);
      const due = computeDueFires(job, lastRun, nowMs);
      for (const fireEpoch of due) {
        // Run one fire at a time; await so ticks never overlap.
        inFlight = fireOne(options, job, fireEpoch).finally(() => {
          inFlight = null;
        });
        await inFlight;
      }
      const next = nextRunAfter(job.parsed, nowMs, job.timezone);
      if (next < earliestNext) earliestNext = next;
    }
    const delay = Math.max(
      0,
      Math.min(MAX_WAKE_MS, earliestNext - nowMs),
    );
    scheduleNext(delay);
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().catch((error: unknown) => {
        console.error(
          `[cron] tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        scheduleNext(MAX_WAKE_MS);
      });
    }, delayMs);
    timer.unref();
  };

  return {
    start(): void {
      scheduleNext(0);
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}

/** Compute the fire epochs (ms) due now for a job given its last run. */
export function computeDueFires(
  job: CronJob,
  lastRunMs: number | null,
  nowMs: number,
): number[] {
  const next = nextRunAfter(job.parsed, lastRunMs ?? 0, job.timezone);
  if (next > nowMs) return [];
  if (job.missed === "skip") {
    // Fire once for the single due time; advance implicitly via lastRun.
    return [next];
  }
  // catchUp: fire once per missed interval up to the cap.
  const fires: number[] = [];
  let cursor = lastRunMs ?? 0;
  for (let i = 0; i < CATCH_UP_CAP; i++) {
    const fire = nextRunAfter(job.parsed, cursor, job.timezone);
    if (fire > nowMs) break;
    fires.push(fire);
    cursor = fire;
  }
  return fires.length > 0 ? fires : [next];
}

/** Run one fire of a job and persist its output + last-run state. */
export async function fireOne(
  options: CronSchedulerOptions,
  job: CronJob,
  fireEpoch: number,
): Promise<void> {
  console.error(`[cron] firing job '${job.id}' for ${new Date(fireEpoch).toISOString()}`);
  const result = await runJobOnce(job, fireEpoch, options);
  await writeRun(options.cronDataDir, job.id, fireEpoch, result.text || "");
  await writeLastRun(options.cronDataDir, job.id, {
    jobId: job.id,
    firedAt: (options.now?.() ?? Date.now()),
    fireEpoch,
    status: result.status,
    sessionFile: result.sessionFile,
    ...(result.error ? { error: result.error } : {}),
    durationMs: result.durationMs,
  });
  console.error(`[cron] job '${job.id}' ${result.status} (${result.durationMs}ms)`);
}

/** Read the persisted last-run epoch for a job, or null if none. */
async function readLastRun(
  cronDataDir: string,
  jobId: string,
): Promise<number | null> {
  const path = join(cronDataDir, "jobs", jobId, "last-run.json");
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return null;
  try {
    const data = JSON.parse(source) as { fireEpoch?: unknown };
    return typeof data.fireEpoch === "number" ? data.fireEpoch : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (mapping only; no third-party dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a small YAML mapping into a plain object. Supports only the cron
 * schedule surface: scalar values, quoted scalars, and a single block scalar
 * (`key: |` with indented lines). Intentionally minimal — schedules are tiny.
 */
export function parseYaml(source: string): unknown {
  const lines = source.split("\n");
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    i++;
    const line = stripComment(raw);
    if (line.trim().length === 0) continue;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const rest = keyMatch[2].trimEnd();
    if (rest === "|") {
      // Block scalar: collect following indented lines.
      const blockLines: string[] = [];
      let indent = -1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim().length === 0) {
          blockLines.push("");
          i++;
          continue;
        }
        const lead = next.search(/\S/);
        if (lead < 0 || (indent >= 0 && lead < indent)) break;
        if (indent < 0) indent = lead;
        blockLines.push(next.slice(indent).replace(/\s+$/, ""));
        i++;
      }
      // Trim trailing blank lines.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
        blockLines.pop();
      }
      result[key] = blockLines.join("\n");
      continue;
    }
    if (rest.length === 0) {
      // Could be a block scalar on the next line; treat empty as null scalar.
      result[key] = "";
      continue;
    }
    result[key] = parseScalar(rest);
  }
  return result;
}

/** Parse a single-line YAML scalar (handles quotes). */
function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strip a `#` comment from a line, respecting quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Executable boot path (run via `bun src/cron-scheduler.ts`)
// ---------------------------------------------------------------------------

/**
 * When executed directly, load env-driven defaults and start the scheduler.
 * The entrypoint invokes this as a supervised child process.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = optionsFromEnv();
  if (options.schedulesDir === undefined) {
    console.error("[cron] OMP_CRON_SCHEDULES_DIR is not set; nothing to do");
  } else {
    const scheduler = startCronScheduler(options);
    scheduler.start();
    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.error(`[cron] received ${signal}; stopping`);
      void scheduler.stop().then(() => process.exit(0));
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
}

/** Resolve scheduler options from the process environment. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): CronSchedulerOptions {
  const schedulesDir = env.OMP_CRON_SCHEDULES_DIR;
  const cronDataDir = env.OMP_CRON_DATA_DIR ?? "/data/cron";
  const workspaceDir = env.OMP_WORKSPACE_DIR ?? "/data/workspace";
  const ompBinary = env.OMP_BINARY?.trim() || "omp";
  const ompModel = env.OMP_MODEL?.trim() || null;
  const ompProfile = env.OMP_PROFILE?.trim() || null;
  const ompArgs = parseArgs(env.OMP_ARGS);
  const ambientExtensionPath = env.OMP_AMBIENT_EXTENSION?.trim() ||
    resolveAmbientExtensionPath();
  return {
    schedulesDir: schedulesDir ?? "",
    cronDataDir,
    workspaceDir,
    ompBinary,
    ompModel,
    ompProfile,
    ompArgs,
    ambientExtensionPath,
  };
}

/** Resolve the ambient-ingest extension path relative to this module. */
function resolveAmbientExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "ambient-ingest-extension.ts");
}

/** Parse a whitespace-or-comma-separated arg list. */
function parseArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}