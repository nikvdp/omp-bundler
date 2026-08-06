import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RpcChild, RpcEventFrame } from "../src/rpc-child.js";
import { parseCronExpression } from "../src/cron-expression.js";
import {
  runJobOnce,
  fireOne,
  loadSchedules,
  parseScheduleFile,
  computeDueFires,
  parseYaml,
  type CronJob,
  type CronSchedulerOptions,
} from "../src/cron-scheduler.js";

// ---------------------------------------------------------------------------
// A minimal RpcChild stub driven by an EventEmitter. It records the commands
// it receives and emits scripted event frames the scheduler must handle.
// ---------------------------------------------------------------------------

interface ScriptedStep {
  kind: "newSession" | "getState" | "prompt";
  response: { success: boolean; data?: unknown; error?: string };
}

function makeFakeChild(opts: {
  deltas: string[];
  sessionFile?: string;
  promptFails?: string;
  noAgentEnd?: boolean;
}): { child: RpcChild; steps: ScriptedStep[] } {
  const ee = new EventEmitter() as unknown as RpcChild;
  const steps: ScriptedStep[] = [];
  let promptCount = 0;

  (ee as unknown as { negotiateProtocolV2: () => Promise<void> }).negotiateProtocolV2 = async () => {};
  (ee as unknown as {
    newSession: () => Promise<{ success: boolean }>;
  }).newSession = async () => {
    steps.push({ kind: "newSession", response: { success: true } });
    return { success: true };
  };
  (ee as unknown as {
    getState: () => Promise<{ success: boolean; data?: unknown }>;
  }).getState = async () => {
    steps.push({ kind: "getState", response: { success: true } });
    return { success: true, data: { sessionFile: opts.sessionFile ?? "/data/sessions/x.json" } };
  };
  (ee as unknown as {
    prompt: (message: string) => Promise<{ success: boolean; error?: string }>;
  }).prompt = async (message: string) => {
    steps.push({ kind: "prompt", response: { success: !opts.promptFails, error: opts.promptFails } });
    void message;
    promptCount++;
    // Emit the scripted deltas then agent_end (unless suppressed).
    if (!opts.promptFails) {
      for (const delta of opts.deltas) {
        (ee as EventEmitter).emit("event", {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta },
        } satisfies RpcEventFrame);
      }
      if (!opts.noAgentEnd) {
        (ee as EventEmitter).emit("event", { type: "agent_end", messages: [] } satisfies RpcEventFrame);
      }
    }
    return { success: !opts.promptFails, error: opts.promptFails };
  };
  (ee as unknown as { close: () => Promise<void> }).close = async () => {};
  void promptCount;
  return { child: ee, steps };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cron-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseOptions(dir: string, overrides: Partial<CronSchedulerOptions> = {}): CronSchedulerOptions {
  return {
    schedulesDir: join(dir, "schedules"),
    cronDataDir: join(dir, "cron"),
    workspaceDir: join(dir, "workspace"),
    ompBinary: "omp",
    ompModel: null,
    ompProfile: null,
    ompArgs: [],
    ambientExtensionPath: join(dir, "ambient.ts"),
    now: () => 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseYaml + parseScheduleFile
// ---------------------------------------------------------------------------

test("parseYaml parses scalars, quoted scalars, and block scalars", () => {
  const parsed = parseYaml([
    'schedule: "0 9 * * 1-5"',
    "timezone: America/New_York",
    "missed: skip",
    "prompt: |",
    "  Line one.",
    "  Line two.",
    "",
  ].join("\n")) as Record<string, unknown>;
  assert.equal(parsed.schedule, "0 9 * * 1-5");
  assert.equal(parsed.timezone, "America/New_York");
  assert.equal(parsed.missed, "skip");
  assert.equal(parsed.prompt, "Line one.\nLine two.");
});

test("parseScheduleFile validates the job schema and parses the cron expression", () => {
  const job = parseScheduleFile("daily", [
    'schedule: "0 9 * * 1-5"',
    "missed: skip",
    'prompt: "Run it."',
    "",
  ].join("\n"));
  assert.equal(job.id, "daily");
  assert.equal(job.timezone, "UTC");
  assert.deepEqual(job.parsed.minute, [0]);
  assert.deepEqual(job.parsed.hour, [9]);
  assert.deepEqual(job.parsed.dayOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(job.prompt, "Run it.");
  assert.equal(job.command, null);
  assert.equal(job.timeout, null);
});

test("parseScheduleFile rejects a bad missed policy, empty prompt, and bad cron", () => {
  assert.throws(
    () => parseScheduleFile("x", ['schedule: "0 9 * * *"', "missed: later", 'prompt: "p"'].join("\n")),
    /missed must be 'skip' or 'catchUp'/,
  );
  assert.throws(
    () => parseScheduleFile("x", ['schedule: "0 9 * * *"', "missed: skip", 'prompt: ""'].join("\n")),
    /prompt must be a non-empty string/,
  );
  assert.throws(
    () => parseScheduleFile("x", ['schedule: "0 9 * * *"', "timezone: Not/A/Zone", "missed: skip", 'prompt: "p"'].join("\n")),
    /not a valid IANA timezone/,
  );
});

test("parseScheduleFile accepts command mode and rejects invalid combinations", () => {
  const job = parseScheduleFile("command", [
    'schedule: "*/10 * * * *"',
    "missed: skip",
    'command: "printf ok"',
    "timeout: 2",
    "",
  ].join("\n"));
  assert.equal(job.prompt, null);
  assert.equal(job.command, "printf ok");
  assert.equal(job.timeout, 2);
  const defaultTimeoutJob = parseScheduleFile("default-timeout", [
    'schedule: "0 9 * * *"',
    "missed: skip",
    'command: "printf ok"',
  ].join("\n"));
  assert.equal(defaultTimeoutJob.timeout, 600);

  assert.throws(
    () => parseScheduleFile("x", [
      'schedule: "0 9 * * *"',
      "missed: skip",
      'prompt: "p"',
      'command: "printf ok"',
    ].join("\n")),
    /exactly one of prompt or command is required/,
  );
  assert.throws(
    () => parseScheduleFile("x", ['schedule: "0 9 * * *"', "missed: skip"].join("\n")),
    /exactly one of prompt or command is required/,
  );
  assert.throws(
    () => parseScheduleFile("x", [
      'schedule: "0 9 * * *"',
      "missed: skip",
      'prompt: "p"',
      "timeout: 1",
    ].join("\n")),
    /timeout is only valid with command/,
  );
  for (const timeout of ["0", "-1", "1.5", "Infinity"]) {
    assert.throws(
      () => parseScheduleFile("x", [
        'schedule: "0 9 * * *"',
        "missed: skip",
        'command: "printf ok"',
        `timeout: ${timeout}`,
      ].join("\n")),
      /timeout must be a positive finite integer/,
    );
  }
});

// ---------------------------------------------------------------------------
// runJobOnce: success captures deltas; persistence happens in fireOne.
// ---------------------------------------------------------------------------

test("runJobOnce captures text deltas and reports ok", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeChild({ deltas: ["Hello, ", "world"] });
    const options = baseOptions(dir, {
      childFactory: async () => fake.child,
      now: () => 1000,
    });
    const job: CronJob = {
      id: "t",
      schedule: "0 9 * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: "hi",
      command: null,
      timeout: null,
      parsed: parseCronExpression("0 9 * * *"),
    };
    const result = await runJobOnce(job, 1000, options);
    assert.equal(result.status, "ok");
    assert.equal(result.text, "Hello, world");
    assert.equal(result.sessionFile, "/data/sessions/x.json");
    assert.equal(fake.steps.map((s) => s.kind).join(","), "newSession,getState,prompt");
  });
});

test("runJobOnce reports an error when prompt fails", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeChild({ deltas: [], promptFails: "boom" });
    const options = baseOptions(dir, {
      childFactory: async () => fake.child,
      now: () => 1000,
    });
    const job: CronJob = {
      id: "t",
      schedule: "0 9 * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: "hi",
      command: null,
      timeout: null,
      parsed: parseCronExpression("0 9 * * *"),
    };
    const result = await runJobOnce(job, 1000, options);
    assert.equal(result.status, "error");
    assert.equal(result.error, "prompt failed: boom");
  });
});

test("runJobOnce reports an error when the child exits without agent_end", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeChild({ deltas: ["partial"], noAgentEnd: true });
    // Emit exit right after prompt resolves to unblock waitForAgentEnd.
    const originalPrompt = (fake.child as unknown as { prompt: (m: string) => Promise<unknown> }).prompt;
    (fake.child as unknown as { prompt: (m: string) => Promise<unknown> }).prompt = async (m: string) => {
      const res = await originalPrompt(m);
      (fake.child as unknown as EventEmitter).emit("exit", 0, null);
      return res;
    };
    const options = baseOptions(dir, {
      childFactory: async () => fake.child,
      now: () => 1000,
    });
    const job: CronJob = {
      id: "t",
      schedule: "0 9 * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: "hi",
      command: null,
      timeout: null,
      parsed: parseCronExpression("0 9 * * *"),
    };
    const result = await runJobOnce(job, 1000, options);
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /agent_end/);
  });
});

test("runJobOnce runs a command and captures stdout", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "workspace"), { recursive: true });
    const options = baseOptions(dir);
    const job: CronJob = {
      id: "command",
      schedule: "* * * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: null,
      command: "printf ok",
      timeout: 5,
      parsed: parseCronExpression("* * * * *"),
    };
    const result = await runJobOnce(job, 0, options);
    assert.equal(result.status, "ok");
    assert.equal(result.text, "ok");
    assert.equal(result.sessionFile, null);
    assert.equal(result.error, null);
  });
});

test("runJobOnce reports a command's nonzero exit", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "workspace"), { recursive: true });
    const options = baseOptions(dir);
    const job: CronJob = {
      id: "command-error",
      schedule: "* * * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: null,
      command: "printf fail >&2; exit 3",
      timeout: 5,
      parsed: parseCronExpression("* * * * *"),
    };
    const result = await runJobOnce(job, 0, options);
    assert.equal(result.status, "error");
    assert.equal(result.text, "fail");
    assert.equal(result.error, "exit code 3");
  });
});

test("runJobOnce times out a long-running command", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "workspace"), { recursive: true });
    const options = baseOptions(dir);
    const job: CronJob = {
      id: "command-timeout",
      schedule: "* * * * *",
      timezone: "UTC",
      missed: "skip",
      prompt: null,
      command: "sleep 5",
      timeout: 1,
      parsed: parseCronExpression("* * * * *"),
    };
    const result = await runJobOnce(job, 0, options);
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /^command timed out after 1s$/);
  });
});

// ---------------------------------------------------------------------------
// computeDueFires: skip vs catchUp
// ---------------------------------------------------------------------------

test("computeDueFires skip fires once for a due time", () => {
  // "0 9 * * *" in UTC. After = 0 (epoch 1970-01-01 00:00 UTC). Next 9am UTC
  // is 9*3600*1000 = 32400000. now just after -> one fire at 32400000.
  const job: CronJob = {
    id: "d",
    schedule: "0 9 * * *",
    timezone: "UTC",
    missed: "skip",
    prompt: "p",
    command: null,
    timeout: null,
    parsed: parseCronExpression("0 9 * * *"),
  };
  const fires = computeDueFires(job, 0, 32_400_001);
  assert.deepEqual(fires, [32_400_000]);
  // Not due yet -> none.
  assert.deepEqual(computeDueFires(job, 0, 32_000_000), []);
});

test("computeDueFires catchUp fires once per missed interval up to the cap", () => {
  // Every minute "* * * * *". lastRun = 0, now = 3 minutes later.
  const job: CronJob = {
    id: "m",
    schedule: "* * * * *",
    timezone: "UTC",
    missed: "catchUp",
    prompt: "p",
    command: null,
    timeout: null,
    parsed: parseCronExpression("* * * * *"),
  };
  const fires = computeDueFires(job, 0, 180_000);
  // Fires at 60000, 120000, 180000 (3 missed, under the cap of 5).
  assert.deepEqual(fires, [60_000, 120_000, 180_000]);
});

test("computeDueFires skip collapses a backlog to the latest due time", () => {
  // Every minute, three intervals behind: skip must fire ONLY the most recent
  // boundary (180000), never replay from 60000 one tick at a time.
  const job: CronJob = {
    id: "m",
    schedule: "* * * * *",
    timezone: "UTC",
    missed: "skip",
    prompt: "p",
    command: null,
    timeout: null,
    parsed: parseCronExpression("* * * * *"),
  };
  assert.deepEqual(computeDueFires(job, 0, 180_000), [180_000]);
});

test("computeDueFires treats a fresh job (null last run) as having no backlog", () => {
  // A never-run job must not catch up from epoch 0; anchored at now, nothing is
  // due until the next boundary arrives.
  const job: CronJob = {
    id: "m",
    schedule: "* * * * *",
    timezone: "UTC",
    missed: "skip",
    prompt: "p",
    command: null,
    timeout: null,
    parsed: parseCronExpression("* * * * *"),
  };
  assert.deepEqual(computeDueFires(job, null, 90_000), []);
});

// ---------------------------------------------------------------------------
// fireOne: end-to-end persistence of one fire
// ---------------------------------------------------------------------------

test("fireOne fires a job and writes the run file + last-run", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeChild({ deltas: ["ok"] });
    const options = baseOptions(dir, {
      childFactory: async () => fake.child,
      now: () => 1_700_000_000_000,
    });
    const job: CronJob = {
      id: "smoke",
      schedule: "0 0 1 1 *",
      timezone: "UTC",
      missed: "skip",
      prompt: "do it",
      command: null,
      timeout: null,
      parsed: parseCronExpression("0 0 1 1 *"),
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      await fireOne(options, job, 1_700_000_000_000);
    } finally {
      console.error = originalError;
    }
    const jobDir = join(dir, "cron", "jobs", "smoke");
    const lastRun = JSON.parse(await readFile(join(jobDir, "last-run.json"), "utf8")) as {
      status: string;
      fireEpoch: number;
      sessionFile: string | null;
    };
    assert.equal(lastRun.status, "ok");
    assert.equal(lastRun.fireEpoch, 1_700_000_000_000);
    assert.equal(lastRun.sessionFile, "/data/sessions/x.json");
    const runs = await readdir(join(jobDir, "runs"));
    assert.equal(runs.length, 1);
    assert.equal(runs[0], "1700000000000.txt");
    assert.equal(await readFile(join(jobDir, "runs", runs[0]), "utf8"), "ok");
  });
});

// ---------------------------------------------------------------------------
// startCronScheduler: the standalone process must stay alive on its own timer.
// An in-process test cannot catch a regression here because the test runner's
// own handles keep the event loop alive, so this spawns the real boot path.
// ---------------------------------------------------------------------------

test("the standalone scheduler process stays alive after start", async () => {
  await withTempDir(async (dir) => {
    // Empty schedules dir: the loop finds no jobs and idles on a long timer.
    // Regression guard: an unref'd tick timer let the process exit 0 before the
    // first tick ever ran, so the entrypoint tore the whole container down.
    const schedulesDir = join(dir, "schedules");
    await mkdir(schedulesDir, { recursive: true });
    const script = fileURLToPath(
      new URL("../src/cron-scheduler.ts", import.meta.url),
    );
    const child = spawn(process.execPath, [script], {
      stdio: "ignore",
      env: {
        ...process.env,
        OMP_CRON_SCHEDULES_DIR: schedulesDir,
        OMP_CRON_DATA_DIR: join(dir, "cron"),
      },
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    try {
      const outcome = await Promise.race([
        exited,
        new Promise<"alive">((r) => setTimeout(() => r("alive"), 2000)),
      ]);
      assert.equal(
        outcome,
        "alive",
        "scheduler process exited early; the tick timer must keep it alive",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});