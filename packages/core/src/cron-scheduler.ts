/**
 * Cron scheduler runtime: an independent process that fires scheduled agent
 * prompts and writes the agent's output to a durable logs directory.
 *
 * This is NOT an adapter. It has no adapter registration, no inbound POST, no
 * Core HTTP path, and no outbound callback. It reuses the OMP `--mode rpc`
 * child machinery ({@link RpcChild}) the way the core supervisor does. Prompt
 * jobs spawn a child, run a fresh session, send the job's prompt, capture
 * assistant text deltas, and write the run output; command jobs run their raw
 * shell string in the workspace. Both modes write a `last-run.json` to
 * `/data/cron/jobs/<job-id>/` before finishing.
 *
 * Filesystem philosophy: schedules are source (`schedules/*.yml` at the bundle
 * root); cron output is durable runtime state under `/data/cron/` that the
 * agent itself can read to answer "what happened on the last cron run?".
 *
 * Lifecycle: `start()` begins a `setTimeout`-driven tick loop. `stop()` drains
 * any in-flight job and resolves. Re-scans `schedules/` on each wake so
 * added/edited jobs take effect without a restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
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
  /** The user message sent to the agent each run, or null for command mode. */
  prompt: string | null;
  /** The raw shell command run each time, or null for prompt mode. */
  command: string | null;
  /** Command timeout in seconds, or null for prompt mode. */
  timeout: number | null;
  /**
   * Run once at startup, in addition to the normal schedule.
   *
   * For work that leaves the durable volume stale after downtime, such as a
   * repo clone: without this a fresh volume stays empty until the next
   * scheduled fire. A boot run never shifts the schedule.
   */
  runAtBoot: boolean;
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
/** Ready timeout for a spawned child; command acks use RpcChild's default. */
const CHILD_READY_TIMEOUT_MS = 30_000;
/** Default timeout for command-mode jobs, in seconds. */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
/** Grace period between command termination signals. */
const COMMAND_KILL_GRACE_MS = 250;

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
  const prompt = optionalString(record, "prompt", id);
  const command = optionalString(record, "command", id);
  if ((prompt === null) === (command === null)) {
    throw new Error(`schedule '${id}': exactly one of prompt or command is required`);
  }
  let timeout: number | null = null;
  if (record.timeout !== undefined) {
    if (command === null) {
      throw new Error(`schedule '${id}': timeout is only valid with command`);
    }
    timeout = parseCommandTimeout(record.timeout, id);
  } else if (command !== null) {
    timeout = DEFAULT_COMMAND_TIMEOUT_SECONDS;
  }
  if (record.runAtBoot !== undefined && typeof record.runAtBoot !== "boolean") {
    throw new Error(`schedule '${id}': runAtBoot must be true or false`);
  }
  const runAtBoot = record.runAtBoot === true;
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
    command,
    timeout,
    runAtBoot,
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

function parseCommandTimeout(value: unknown, id: string): number {
  const timeout = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`schedule '${id}': timeout must be a positive finite integer`);
  }
  return timeout;
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
 * Run one cron job fire in the appropriate mode and return its result.
 */
export function runJobOnce(
  job: CronJob,
  fireEpoch: number,
  options: CronSchedulerOptions,
): Promise<RunResult> {
  if (job.command !== null) return runCommandOnce(job, fireEpoch, options);
  return runPromptOnce(job, fireEpoch, options);
}

/**
 * Spawn an OMP RPC child, create a fresh session, send the prompt, capture
 * assistant text deltas until `agent_end`, and return the run result. The
 * child is always closed in a finally block.
 */
async function runPromptOnce(
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
    const promptRes = await child.prompt(job.prompt!);
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

/** Run one command-mode job through `sh -c`, bounded by its timeout. */
async function runCommandOnce(
  job: CronJob,
  _fireEpoch: number,
  options: CronSchedulerOptions,
): Promise<RunResult> {
  const startedAt = options.now?.() ?? Date.now();
  const command = job.command!;
  const timeoutSeconds = job.timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  return new Promise<RunResult>((resolve) => {
    let child: ChildProcess | null = null;
    let text = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (status: "ok" | "error", error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      resolve({
        status,
        text,
        sessionFile: null,
        error,
        durationMs: (options.now?.() ?? Date.now()) - startedAt,
      });
    };
    const timeoutError = (): string => `command timed out after ${timeoutSeconds}s`;

    try {
      child = spawn("sh", ["-c", command], {
        cwd: options.workspaceDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish("error", error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    child.once("error", (error) => {
      if (!timedOut) finish("error", error instanceof Error ? error.message : String(error));
    });
    child.once("close", (code) => {
      if (timedOut) {
        finish("error", timeoutError());
      } else if (code === 0) {
        finish("ok", null);
      } else {
        finish("error", `exit code ${code ?? "unknown"}`);
      }
    });
    timeoutTimer = setTimeout(() => {
      if (settled || !child) return;
      timedOut = true;
      killCommandProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled || !child) return;
        killCommandProcess(child, "SIGKILL");
        finish("error", timeoutError());
      }, COMMAND_KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/** Terminate a detached command's process group, falling back to its child. */
function killCommandProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The child may have exited between the close check and this signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the close check and this signal.
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
  // Jobs whose boot run already happened in this process, so a reload or a
  // later tick never repeats it.
  const bootRan = new Set<string>();

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
      if (!job.runAtBoot || bootRan.has(job.id)) continue;
      bootRan.add(job.id);
      // Deliberately not fireOne: a boot run must not advance the schedule
      // anchor. Writing last-run here would make a job on a 10 minute cron
      // that boots at 15:51 next fire at 16:01 instead of 16:00, and would
      // swallow a catchUp window. The run output is still recorded.
      inFlight = runAtBootOnce(options, job, nowMs).finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    for (const job of jobs) {
      const lastRun = await readLastRun(options.cronDataDir, job.id);
      if (lastRun === null) {
        // First time we see this job: anchor at now so its first fire is the
        // next scheduled boundary, not a catch-up from epoch 0. No fire yet.
        await writeLastRun(options.cronDataDir, job.id, {
          jobId: job.id,
          fireEpoch: nowMs,
          anchoredAt: nowMs,
        });
      } else {
        const due = computeDueFires(job, lastRun, nowMs);
        for (const fireEpoch of due) {
          // Run one fire at a time; await so ticks never overlap.
          inFlight = fireOne(options, job, fireEpoch).finally(() => {
            inFlight = null;
          });
          await inFlight;
        }
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
  // A fresh job (no persisted last run) has no backlog: anchor at now so the
  // first fire is the next scheduled boundary, never a catch-up from epoch 0.
  const base = lastRunMs ?? nowMs;
  if (job.missed === "skip") {
    // Fire at most once, at the most recent due boundary; drop any backlog so
    // downtime never replays missed fires one tick at a time.
    let latest = -1;
    let cursor = base;
    for (;;) {
      const fire = nextRunAfter(job.parsed, cursor, job.timezone);
      if (fire > nowMs) break;
      latest = fire;
      cursor = fire;
    }
    return latest >= 0 ? [latest] : [];
  }
  // catchUp: fire once per missed interval up to the cap.
  const fires: number[] = [];
  let cursor = base;
  for (let i = 0; i < CATCH_UP_CAP; i++) {
    const fire = nextRunAfter(job.parsed, cursor, job.timezone);
    if (fire > nowMs) break;
    fires.push(fire);
    cursor = fire;
  }
  return fires;
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

/**
 * Run a `runAtBoot` job once at startup.
 *
 * Shares execution and run-output recording with {@link fireOne} but does not
 * write last-run state: that field is what the tick loop reads to decide when
 * a job is next due, so writing it here would move the schedule. A boot run is
 * an extra execution alongside the schedule, never a substitute for one.
 */
export async function runAtBootOnce(
  options: CronSchedulerOptions,
  job: CronJob,
  atMs: number,
): Promise<void> {
  console.error(`[cron] boot run for job '${job.id}'`);
  const result = await runJobOnce(job, atMs, options);
  await writeRun(options.cronDataDir, job.id, atMs, result.text || "");
  console.error(
    `[cron] job '${job.id}' boot run ${result.status} (${result.durationMs}ms)`,
  );
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
// YAML
// ---------------------------------------------------------------------------

/**
 * Parse a schedule file.
 *
 * Uses the runtime's YAML parser rather than a hand-rolled one. The previous
 * minimal implementation returned every scalar as a string, so `runAtBoot:
 * true` arrived as `"true"` and `timeout: 600` as `"600"`, pushing type
 * coercion into each field's validation.
 */
export function parseYaml(source: string): unknown {
  return Bun.YAML.parse(source);
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
  const cronDataDir = env.OMP_CRON_DATA_DIR ?? "/data/cron";
  const schedulesDir = env.OMP_CRON_SCHEDULES_DIR ?? join(cronDataDir, "schedules");
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