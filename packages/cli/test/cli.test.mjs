import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  main,
  buildCommand,
  checkCommand,
  applyFilePlan,
  createFilePlan,
  commandArgs,
  destroyCommand,
  generateCommand,
  handlerContext,
  newCommand,
  runCommand,
  restartCommand,
  statusCommand,
  tuiCommand,
  PACKAGE_ASSET_PATHS,
  removeDockerContext,
  modelCommand,
  stageDockerContext,
  stagePackagedAssets,
} from "../src/index.ts";
import {
  buildPreviewCommand,
  discoverPublishedAdapterPort,
  resolveBuildTag,
  resolveTuiTarget,
  resolveAvailableRunSettings,
  runReadlineChat,
  resolveRunSettings,
  runPreviewCommand,
  validateBundle,
} from "../src/commands/index.ts";
import { parseYaml } from "../src/config.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRYPOINT = join(REPO_ROOT, "entrypoint", "entrypoint.sh");

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}
async function unusedTcpPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "0.0.0.0", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return address.port;
}

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function snapshotTree(root) {
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else {
        files.push([relativePath, await readFile(path)]);
      }
    }
  }
  await visit(root, "");
  return files.sort(([left], [right]) => left.localeCompare(right));
}

async function transactionArtifacts(root) {
  const paths = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.startsWith(".omp-bundler-txn-")) paths.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return paths;
}

function captureIO() {
  const stdout = [];
  const stderr = [];
  const sink = (target) => new Writable({
    write(chunk, _encoding, callback) {
      target.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  return {
    io: {
      stdin: Readable.from([]),
      stdout: sink(stdout),
      stderr: sink(stderr),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}
function sseResponse(source, byteChunks = []) {
  const bytes = new TextEncoder().encode(source);
  const boundaries = [...new Set([0, ...byteChunks, bytes.length])].sort((left, right) => left - right);
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 1; index < boundaries.length; index += 1) {
        controller.enqueue(bytes.slice(boundaries[index - 1], boundaries[index]));
      }
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

async function runChild(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function invoke(handler, cwd, positionals, options = {}) {
  const capture = captureIO();
  const result = await handler(
    commandArgs(positionals, options),
    handlerContext(cwd, capture.io),
  );
  return { result, stdout: capture.stdout(), stderr: capture.stderr() };
}

async function invokeWithInput(handler, cwd, positionals, options, input) {
  const capture = captureIO();
  capture.io.stdin = Readable.from((async function* () {
    for (const line of input.matchAll(/[^\n]*\n/g)) {
      yield line[0];
      await delay(1);
    }
  })());
  Object.defineProperty(capture.io.stdin, "isTTY", { value: true });
  const result = await handler(
    commandArgs(positionals, options),
    handlerContext(cwd, capture.io),
  );
  return { result, stdout: capture.stdout(), stderr: capture.stderr() };
}

async function withTempDirectory(callback) {
  // Match production process.cwd() by canonicalizing the temp root: physical
  // bundle paths keep the realpath root guard from tripping on the Darwin
  // /var alias above canonical temp directories.
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-bundler-cli-test-")));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createEntrypointHarness(root) {
  const binDir = join(root, "entrypoint-bin");
  const buildDir = join(root, "entrypoint-build");
  const homeDir = join(root, "entrypoint-home");
  const orphanSweep = join(root, "orphan-sweep.ts");
  const coreServer = join(root, "core-server.ts");
  const httpServer = join(root, "http-server.ts");
  const pumbleServer = join(root, "pumble-server.ts");
  const cronServer = join(root, "cron-server.ts");
  const ambientExtension = join(root, "ambient-ingest-extension.ts");
  await mkdir(binDir, { recursive: true });
  await writeText(join(buildDir, "render-models.ts"), "export {};\n");
  await writeText(join(homeDir, ".omp", "agent", "models.yml.tmpl"), "{}\n");
  await writeText(orphanSweep, "export {};\n");
  await writeText(coreServer, "export {};\n");
  await writeText(httpServer, "export {};\n");
  await writeText(pumbleServer, "export {};\n");
  await writeText(cronServer, "export {};\n");
  await writeText(ambientExtension, "export {};\n");
  const capturePath = join(root, "entrypoint-capture.json");
  await writeFile(
    join(binDir, "bun"),
    `#!${process.execPath}
const { copyFileSync, mkdirSync, renameSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0]?.endsWith("/render-models.ts")) {
  const input = args[args.indexOf("--input") + 1];
  const output = args[args.indexOf("--output") + 1];
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(input, output);
} else if (args[0] === "-e") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", args[1]], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.exit(result.status ?? 1);
} else if (process.env.ENTRYPOINT_CAPTURE_PATH && args[0] === process.env.OMP_CORE_SERVER) {
  const capture = JSON.stringify({
    OMP_ADAPTERS: process.env.OMP_ADAPTERS,
    OMP_AGENT_ID: process.env.OMP_AGENT_ID,
    OMP_AGENT_ROOT: process.env.OMP_AGENT_ROOT,
    OMP_WORKSPACE_DIR: process.env.OMP_WORKSPACE_DIR,
    OMP_AGENT_DIR: process.env.OMP_AGENT_DIR,
    OMP_ARGS: process.env.OMP_ARGS,
    OMP_CRON_SCHEDULES_DIR: process.env.OMP_CRON_SCHEDULES_DIR,
  });
  writeFileSync(process.env.ENTRYPOINT_CAPTURE_PATH + ".tmp", capture);
  renameSync(process.env.ENTRYPOINT_CAPTURE_PATH + ".tmp", process.env.ENTRYPOINT_CAPTURE_PATH);
} else if ([process.env.OMP_HTTP_SERVER, process.env.OMP_PUMBLE_SERVER, process.env.OMP_CRON_SERVER].includes(args[0])) {
  setInterval(() => {}, 1000);
}
`,
    { encoding: "utf8", mode: 0o755 },
  );

  return {
    async run(agentSrc, dataDir, overrides = {}) {
      await rm(capturePath, { force: true });
      const env = {
        ...process.env,
        AGENT_SRC: agentSrc,
        OMP_DATA_DIR: dataDir,
        OMP_BUILD_DIR: buildDir,
        OMP_ORPHAN_SWEEP: orphanSweep,
        OMP_CORE_SERVER: coreServer,
        OMP_HTTP_SERVER: httpServer,
        OMP_PUMBLE_SERVER: pumbleServer,
        OMP_CRON_SERVER: cronServer,
        OMP_AMBIENT_EXTENSION: ambientExtension,
        OMP_CHILD_REGISTRY_PATH: join(dataDir, "child-registry.json"),
        OMP_BUNDLER_ADAPTER: "http",
        OMP_HTTP_CORE_SHARED_SECRET: "http-test-secret",
        ENTRYPOINT_CAPTURE_PATH: capturePath,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      for (const key of [
        "AGENTS_SRC",
        "OMP_ADAPTERS",
        "OMP_AGENT_ID",
        "OMP_AGENT_ROOT",
        "OMP_WORKSPACE_DIR",
        "OMP_AGENT_DIR",
        "PUMBLE_AGENT_ID",
        "PUMBLE_CORE_SHARED_SECRET",
      ]) {
        delete env[key];
      }
      Object.assign(env, overrides);
      delete env.OMP_AUTH_BROKER_URL;
      delete env.OMP_AUTH_BROKER_TOKEN;
      const result = await new Promise((resolveRun, rejectRun) => {
        const child = spawn("bash", [ENTRYPOINT], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", rejectRun);
        child.once("close", (code, signal) =>
          resolveRun({ code, signal, stdout, stderr }),
        );
      });
      if (result.code === 0) await waitForFile(capturePath);
      const capture = (await exists(capturePath))
        ? JSON.parse(await readFile(capturePath, "utf8"))
        : null;
      return { ...result, capture };
    },
  };
}

async function createStagedAgent(root, name, agentId, config) {
  const source = join(root, name);
  await writeText(join(source, "id"), `${agentId}\n`);
  await writeText(
    join(source, ".omp", "AGENTS.md"),
    `# ${agentId}\n\nStaged instructions.\n`,
  );
  await writeText(join(source, ".omp", "config.yml"), config);
  return source;
}
async function createLegacyAgent(root, agentId) {
  const agentRoot = join(root, "agents", agentId);
  const omp = join(agentRoot, ".omp");
  await writeText(join(omp, "AGENTS.md"), `# ${agentId}\n\nLegacy hidden-layout instructions.\n`);
  await writeText(join(omp, "config.yml"), "setupVersion: 1\n");
  await writeText(join(omp, "agents", "researcher.md"), "---\nname: researcher\ndescription: Legacy researcher subagent.\ntools: read, grep, glob\nspawns: \"\"\n---\n\nYou are researcher.\n");
  await writeText(join(omp, "commands", "summarize.md"), "---\ndescription: Legacy summarize command.\n---\n\nSummarize the context.\n");
  await writeText(join(omp, "extensions", "lifecycle.ts"), "export default function lifecycle() {}\n");
  await writeText(join(omp, "skills", "knowledge-base", "SKILL.md"), "---\nname: knowledge-base\ndescription: Legacy skill.\n---\n\nSkill body.\n");
  await writeText(join(omp, "tools", "lookup.ts"), "export default () => ({ execute: async () => ({}) });\n");
  return { agentRoot, omp };
}

async function createCanonicalAssetSource(root) {
  await writeText(join(root, "Dockerfile"), "FROM scratch\n");
  await writeText(join(root, ".dockerignore"), "node_modules\n");
  await writeText(join(root, "build", "build-image.ts"), "export {};\n");
  await writeText(join(root, "entrypoint", "entrypoint.sh"), "#!/bin/sh\n");
  await writeText(join(root, "template", "config.yml"), "version: 1\n");

  for (const [packageRoot, paths] of Object.entries(PACKAGE_ASSET_PATHS)) {
    for (const path of paths) {
      const target = join(root, packageRoot, path);
      if (path === "src" || path === "schemas") {
        await writeText(join(target, "index.ts"), "export {};\n");
      } else {
        await writeText(target, "{}\n");
      }
    }
  }
  await writeText(join(root, "dist", "ignored.js"), "ignored\n");
  await writeText(join(root, "node_modules", "ignored.js"), "ignored\n");
  await writeText(join(root, "packages", "core", "test", "ignored.test.ts"), "ignored\n");
}

function runtimeEnv() {
  return [
    "OMP_BUNDLER_ADAPTER=pumble",
    "PUMBLE_APP_ID=app",
    "PUMBLE_APP_CLIENT_SECRET=client-secret",
    "PUMBLE_APP_KEY=app-key",
    "PUMBLE_APP_SIGNING_SECRET=signing-secret",
    "PUMBLE_PUBLIC_BASE_URL=http://localhost:3000",
    "PUMBLE_CORE_SHARED_SECRET=shared-secret",
    "",
  ].join("\n");
}

function quoteYamlValue(value) {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** Write the root models.yml catalog and select its model. */
async function seedModel(root, _agentId, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? "https://api.test.example/v1";
  const dialect = overrides.dialect ?? "openai-responses";
  const model = overrides.model ?? "gpt-test";
  await writeText(join(root, "models.yml"), [
    "providers:",
    "  test:",
    `    baseUrl: ${quoteYamlValue(baseUrl)}`,
    `    api: ${dialect}`,
    "    auth: none",
    "    models:",
    `      - id: ${quoteYamlValue(model)}`,
    `        name: ${quoteYamlValue(model)}`,
    "setupVersion: 1",
    "",
  ].join("\n"));
  await writeText(join(root, "config.yml"), [
    "setupVersion: 1",
    "# Add agent-local OMP settings here.",
    "modelRoles:",
    `  default: test/${model}`,
    "",
  ].join("\n"));
}
async function withEditor(editorPath, callback) {
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  process.env.EDITOR = editorPath;
  delete process.env.VISUAL;
  try {
    return await callback();
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
  }
}

/** A fake npm/js editor script that rewrites its argument (or exits). */
async function writeEditorScript(parent, name, body) {
  const script = join(parent, name);
  await writeFile(script, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return script;
}

test("CLI framework owns command parsing, help, and shell completions", async () => {
  const invocation = [];
  const capture = captureIO();
  const code = await main(
    ["run", "/bundle", "--foreground", "--dry-run"],
    {
      cwd: "/work",
      io: capture.io,
      handlers: {
        run(args, context) {
          invocation.push({ args, cwd: context.cwd });
          return 0;
        },
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(invocation, [{
    args: {
      positionals: ["/bundle"],
      options: { foreground: true, "dry-run": true },
    },
    cwd: "/work",
  }]);

  const startInvocation = [];
  const startCapture = captureIO();
  assert.equal(await main(
    ["start", "/bundle", "--dry-run"],
    {
      cwd: "/work",
      io: startCapture.io,
      handlers: {
        start(args) {
          startInvocation.push(args);
          return 0;
        },
      },
    },
  ), 0);
  assert.deepEqual(startInvocation, [{
    positionals: ["/bundle"],
    options: { "dry-run": true },
  }]);

  const help = captureIO();
  assert.equal(await main(["run", "--help"], { cwd: "/work", io: help.io }), 0);
  assert.match(help.stdout(), /Start the bundle as a background service/);
  assert.match(help.stdout(), /--foreground/);

  const completion = captureIO();
  assert.equal(await main(["completion", "fish"], { cwd: "/work", io: completion.io }), 0);
  assert.match(completion.stdout(), /complete -c omp-bundler/);

  const legacy = captureIO();
  assert.equal(await main(["service", "status"], { cwd: "/work", io: legacy.io }), 1);
  assert.match(legacy.stderr(), /Unknown command: service/);
});

test("generate and destroy accept the schedule kind through the parser", async () => {
  const generateCalls = [];
  const generateCapture = captureIO();
  assert.equal(await main(["generate", "schedule", "daily"], {
    cwd: "/work",
    io: generateCapture.io,
    handlers: { generate(args) { generateCalls.push(args.positionals); return 0; } },
  }), 0);
  assert.deepEqual(generateCalls, [["schedule", "daily"]]);

  const destroyCalls = [];
  const destroyCapture = captureIO();
  assert.equal(await main(["destroy", "schedule", "daily", "--yes"], {
    cwd: "/work",
    io: destroyCapture.io,
    handlers: { destroy(args) { destroyCalls.push(args.positionals); return 0; } },
  }), 0);
  assert.deepEqual(destroyCalls, [["schedule", "daily"]]);
});

test("compiled standalone invokes the CLI main module", async () => {
  await withTempDirectory(async (root) => {
    const executable = join(root, "omp-bundler");
    const built = await runChild(
      "bun",
      ["build", "--compile", join(REPO_ROOT, "packages", "cli", "src", "cli.ts"), "--outfile", executable],
      REPO_ROOT,
    );
    assert.equal(built.code, 0, built.stderr);
    const version = await runChild(executable, ["--version"], REPO_ROOT);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), "0.1.0");
  });
});

test("entrypoint refreshes only singular .omp, preserves workspace, and registers one HTTP adapter", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "data");
    const imageV1 = await createStagedAgent(
      root,
      "image-v1",
      "alpha",
      "image-v1\n",
    );
    const first = await harness.run(imageV1, dataDir);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(
      await readdir(join(dataDir, "agent", "workspace")),
      [],
      "the persistent agent workspace starts empty",
    );
    const runtimeAgentDir = join(
      root,
      "entrypoint-home",
      ".omp",
      "runtime-agent",
    );
    await writeText(
      join(runtimeAgentDir, "stale-runtime.txt"),
      "remove stale runtime copy\n",
    );

    const workspaceFile = join(dataDir, "agent", "workspace", "notes.txt");
    const siblingFile = join(dataDir, "agent", "operator.txt");
    const legacyDefinition = join(
      dataDir,
      "agents",
      "old",
      ".omp",
      "config.yml",
    );
    await writeText(workspaceFile, "keep workspace\n");
    await writeText(siblingFile, "keep sibling\n");
    await writeText(legacyDefinition, "leave legacy tree untouched\n");
    await writeText(
      join(dataDir, "agent", ".omp", "stale.txt"),
      "remove stale definition\n",
    );

    const imageV2 = await createStagedAgent(
      root,
      "image-v2",
      "alpha",
      "image-v2\n",
    );
    await writeText(
      join(imageV2, ".omp", "skills", "meeting-notes", "SKILL.md"),
      "# Meeting notes\n",
    );
    const second = await harness.run(imageV2, dataDir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(
      await readFile(join(dataDir, "agent", ".omp", "config.yml"), "utf8"),
      "image-v2\n",
    );
    assert.equal(await exists(join(dataDir, "agent", ".omp", "stale.txt")), false);
    assert.equal(await readFile(workspaceFile, "utf8"), "keep workspace\n");
    assert.equal(await readFile(siblingFile, "utf8"), "keep sibling\n");
    assert.equal(
      await readFile(legacyDefinition, "utf8"),
      "leave legacy tree untouched\n",
    );
    assert.equal(second.capture.OMP_AGENT_ID, "alpha");
    assert.equal(second.capture.OMP_AGENT_ROOT, join(dataDir, "agent"));
    assert.equal(second.capture.OMP_WORKSPACE_DIR, join(dataDir, "workspace"));
    assert.equal(second.capture.OMP_AGENT_DIR, runtimeAgentDir);
    assert.equal(
      await readFile(join(runtimeAgentDir, "config.yml"), "utf8"),
      "image-v2\n",
    );
    assert.equal(
      await readFile(join(runtimeAgentDir, "AGENTS.md"), "utf8"),
      "# alpha\n\nStaged instructions.\n",
    );
    assert.equal(
      await readFile(
        join(runtimeAgentDir, "skills", "meeting-notes", "SKILL.md"),
        "utf8",
      ),
      "# Meeting notes\n",
    );
    assert.equal(
      await exists(join(runtimeAgentDir, "stale-runtime.txt")),
      false,
    );
    assert.equal(
      await readFile(join(runtimeAgentDir, "models.yml"), "utf8"),
      "{}\n",
    );
    assert.equal(
      (await lstat(join(runtimeAgentDir, "sessions"))).isSymbolicLink(),
      true,
    );
    assert.equal(
      await realpath(join(runtimeAgentDir, "sessions")),
      await realpath(join(dataDir, "sessions")),
    );
    assert.equal(
      await exists(join(dataDir, "agent", ".omp", "models.yml")),
      false,
      "the secret-bearing rendered model catalog must stay off the data volume",
    );
    assert.deepEqual(JSON.parse(second.capture.OMP_ADAPTERS), [
      {
        adapterId: "http-alpha",
        callbackUrl: "http://127.0.0.1:8765/core/events/alpha",
        sharedSecret: "http-test-secret",
        agentId: "alpha",
      },
    ]);
  });
});

test("entrypoint persists live cron schedules and exposes their workspace root", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "cron-data");
    const source = await createStagedAgent(root, "image", "alpha", "config\n");
    const bakedSchedules = join(root, "baked-schedules");
    await writeText(
      join(bakedSchedules, "daily.yml"),
      'schedule: "0 9 * * *"\nmissed: skip\nprompt: "original"\n',
    );
    await writeText(
      join(bakedSchedules, "example-schedule.yml.example"),
      'schedule: "0 9 * * *"\nmissed: skip\nprompt: "inactive"\n',
    );

    const first = await harness.run(source, dataDir, {
      OMP_ARGS: "--profile test",
      OMP_CRON_ENABLED: "true",
      OMP_CRON_SOURCE_DIR: bakedSchedules,
    });
    assert.equal(first.code, 0, first.stderr);
    const liveSchedules = join(dataDir, "cron", "schedules");
    assert.equal(
      await readFile(join(liveSchedules, "daily.yml"), "utf8"),
      'schedule: "0 9 * * *"\nmissed: skip\nprompt: "original"\n',
    );
    assert.equal(first.capture.OMP_CRON_SCHEDULES_DIR, liveSchedules);
    assert.equal(first.capture.OMP_ARGS, `--profile test --add-dir ${join(dataDir, "cron")}`);

    await writeText(
      join(liveSchedules, "daily.yml"),
      'schedule: "0 10 * * *"\nmissed: skip\nprompt: "edited"\n',
    );
    await rm(join(liveSchedules, "example-schedule.yml.example"));

    const second = await harness.run(source, dataDir, {
      OMP_ARGS: "--profile test",
      OMP_CRON_ENABLED: "true",
      OMP_CRON_SOURCE_DIR: bakedSchedules,
    });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(
      await readFile(join(liveSchedules, "daily.yml"), "utf8"),
      'schedule: "0 10 * * *"\nmissed: skip\nprompt: "edited"\n',
    );
    assert.equal(
      await exists(join(liveSchedules, "example-schedule.yml.example")),
      false,
    );
  });
});

test("entrypoint synthesizes one Pumble registration and preserves an OMP_ADAPTERS override", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "data");
    const source = await createStagedAgent(
      root,
      "image",
      "alpha",
      "config\n",
    );

    const pumble = await harness.run(source, dataDir, {
      OMP_BUNDLER_ADAPTER: "pumble",
      PUMBLE_ADAPTER_ID: "team-chat",
      PUMBLE_CORE_SHARED_SECRET: "pumble-test-secret",
    });
    assert.equal(pumble.code, 0, pumble.stderr);
    assert.deepEqual(JSON.parse(pumble.capture.OMP_ADAPTERS), [
      {
        adapterId: "team-chat",
        callbackUrl: "http://127.0.0.1:8765/core/events",
        sharedSecret: "pumble-test-secret",
        agentId: "alpha",
      },
    ]);

    const override = JSON.stringify([
      {
        adapterId: "custom",
        callbackUrl: "https://adapter.example.test/events",
        sharedSecret: "custom-secret",
      },
    ]);
    const custom = await harness.run(source, dataDir, {
      OMP_ADAPTERS: override,
    });
    assert.equal(custom.code, 0, custom.stderr);
    assert.equal(custom.capture.OMP_ADAPTERS, override);

    const mismatchedPumble = await harness.run(source, join(root, "pumble-mismatch"), {
      OMP_BUNDLER_ADAPTER: "pumble",
      PUMBLE_ADAPTER_ID: "team-chat",
      PUMBLE_CORE_SHARED_SECRET: "pumble-test-secret",
      OMP_ADAPTERS: JSON.stringify([{
        adapterId: "other-chat",
        callbackUrl: "http://127.0.0.1:8765/core/events",
        sharedSecret: "pumble-test-secret",
        agentId: "alpha",
      }]),
    });
    assert.notEqual(mismatchedPumble.code, 0);
    assert.match(mismatchedPumble.stderr, /adapterId matches PUMBLE_ADAPTER_ID/);
  });
});

test("entrypoint rejects invalid ids and durable agent symlinks", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "data");
    const invalid = await createStagedAgent(
      root,
      "invalid",
      "../escape",
      "config\n",
    );

    const invalidId = await harness.run(invalid, dataDir);
    assert.notEqual(invalidId.code, 0);
    assert.match(invalidId.stderr, /must contain an agent id matching/);
    assert.equal(await exists(join(dataDir, "agent")), false);

    const source = await createStagedAgent(
      root,
      "valid",
      "alpha",
      "config\n",
    );
    const emptyAdapters = await harness.run(source, join(root, "empty-adapters"), {
      OMP_ADAPTERS: "",
    });
    assert.notEqual(emptyAdapters.code, 0);
    assert.match(emptyAdapters.stderr, /OMP_ADAPTERS must not be empty when explicitly set/);
    const outside = join(root, "outside");
    await writeText(join(outside, "sentinel.txt"), "outside\n");
    await mkdir(dataDir, { recursive: true });
    await symlink(outside, join(dataDir, "agent"));

    const agentLink = await harness.run(source, dataDir);
    assert.notEqual(agentLink.code, 0);
    assert.match(agentLink.stderr, /must not be a symlink/);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside\n");

    await rm(join(dataDir, "agent"), { force: true });
    await mkdir(join(dataDir, "agent", "workspace"), { recursive: true });
    await symlink(outside, join(dataDir, "agent", ".omp"));
    const ompLink = await harness.run(source, dataDir);
    assert.notEqual(ompLink.code, 0);
    assert.match(ompLink.stderr, /must not be a symlink/);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside\n");
  });
});

test("new creates the full root scaffold and derives or accepts an agent id", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["derived"]);
    const derived = join(parent, "derived");
    assert.deepEqual(
      new Set(await readdir(derived)),
      new Set([
        ".gitignore",
        "README.md",
        "omp-bundler.yml",
        "runtime.env.example",
        "models.yml",
        "Dockerfile",
        "AGENTS.md",
        "config.yml",
        "subagents",
        "commands",
        "extensions",
        "skills",
        "tools",
        "schedules",
      ]),
    );
    for (const relativePath of [
      join("subagents", "example-subagent.md.example"),
      join("commands", "example-command.md.example"),
      join("extensions", "example-extension.ts.example"),
      join("skills", "example-skill", "SKILL.md.example"),
      join("tools", "example-tool.ts.example"),
      join("schedules", "example-schedule.yml.example"),
    ]) {
      assert.equal(await exists(join(derived, relativePath)), true, relativePath);
    }
    const starterModels = parseYaml(await readFile(join(derived, "models.yml"), "utf8"));
    assert.deepEqual(starterModels, { providers: {} });
    assert.match(await readFile(join(derived, "Dockerfile"), "utf8"), /FROM oven\/bun:/);
    assert.match(
      await readFile(join(derived, "Dockerfile"), "utf8"),
      /extra system tools \(customize\)/,
    );
    assert.deepEqual(
      parseYaml(await readFile(join(derived, "omp-bundler.yml"), "utf8"))
        .agent,
      { id: "derived" },
    );
    const generatedReadme = await readFile(join(derived, "README.md"), "utf8");
    assert.match(generatedReadme, /\.example.*inactive/);
    assert.match(generatedReadme, /omp-bundler generate skill meeting-notes/);
    assert.match(generatedReadme, /model add <provider\/model>/);
    assert.match(generatedReadme, /discovers the live adapter port automatically/);
    assert.match(generatedReadme, /generate schedule/);

    await invoke(newCommand, parent, ["custom"], { id: "alpha" });
    const custom = join(parent, "custom");
    assert.equal(
      parseYaml(await readFile(join(custom, "omp-bundler.yml"), "utf8")).agent
        .id,
      "alpha",
    );
    await assert.rejects(
      () => invoke(newCommand, parent, ["bad"], { agent: "alpha" }),
      /unknown option/,
    );
  });
});

test("component generators and destroy commands use root paths without deployed agent ids", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    const components = [
      ["skill", "knowledge-base", join("skills", "knowledge-base", "SKILL.md")],
      ["command", "summarize", join("commands", "summarize.md")],
      ["tool", "lookup-record", join("tools", "lookup-record.ts")],
      ["extension", "lifecycle-log", join("extensions", "lifecycle-log.ts")],
      ["subagent", "researcher", join("subagents", "researcher.md")],
      ["schedule", "daily-summary", join("schedules", "daily-summary.yml")],
    ];
    for (const [kind, name, relativePath] of components) {
      await invoke(generateCommand, bundle, [kind, name]);
      assert.equal(await exists(join(bundle, relativePath)), true);
    }
    assert.deepEqual(
      parseYaml(await readFile(join(bundle, "schedules", "daily-summary.yml"), "utf8")),
      {
        schedule: "0 9 * * 1-5",
        timezone: "UTC",
        missed: "skip",
        prompt: "Replace this with the prompt daily-summary should run on schedule.",
      },
    );
    const generatedAdapter = await invoke(generateCommand, bundle, ["adapter", "pumble"]);
    assert.equal(generatedAdapter.result, undefined);
    const envExample = await readFile(join(bundle, "runtime.env.example"), "utf8");
    assert.match(envExample, /PUMBLE_APP_ID=/);
    assert.doesNotMatch(envExample, /PUMBLE_AGENT_ID/);
    assert.equal((await invoke(generateCommand, bundle, ["adapter", "pumble"])).stdout, `no changes ${join(bundle, "runtime.env.example")}\n`);

    await assert.rejects(
      () => invoke(generateCommand, bundle, ["skill", "alpha", "wrong"]),
      /usage: omp-bundler generate skill <name>/,
    );
    await assert.rejects(
      () => invoke(generateCommand, bundle, ["schedule", "two", "args"]),
      /usage: omp-bundler generate schedule <name>/,
    );
    await assert.rejects(
      () => invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" }),
      /unknown option/,
    );
    await assert.rejects(() => invoke(destroyCommand, bundle, ["agent", "alpha"]), /unknown destroy target/);

    for (const [kind, name, relativePath] of components) {
      const preview = await invoke(destroyCommand, bundle, [kind, name], { "dry-run": true });
      assert.match(preview.stdout, /dry-run: remove/);
      assert.equal(await exists(join(bundle, relativePath)), true);
      await invoke(destroyCommand, bundle, [kind, name], { yes: true });
      assert.equal(await exists(join(bundle, relativePath)), false);
    }
  });
});

test("model catalog adds providers and models without changing the default selection", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    const direct = await invoke(modelCommand, bundle, ["add", "direct/direct-model"], {
      "base-url": "https://direct.example/v1",
      api: "openai-responses",
      "no-auth": true,
    });
    assert.equal(direct.result, 0, direct.stderr);
    let catalog = parseYaml(await readFile(join(bundle, "models.yml"), "utf8"));
    assert.deepEqual(catalog.providers.direct.models, [{ id: "direct-model", name: "direct-model" }]);
    assert.doesNotMatch(await readFile(join(bundle, "config.yml"), "utf8"), /modelRoles/);

    await invoke(modelCommand, bundle, ["set-default", "direct/direct-model"]);
    assert.match(await readFile(join(bundle, "config.yml"), "utf8"), /default: direct\/direct-model/);
    await assert.rejects(
      () => invoke(modelCommand, bundle, ["set-default", "direct/missing"]),
      /is not present in models.yml/,
    );

    const ompConfig = join(parent, "omp-config");
    await writeText(join(ompConfig, "models.yml"), [
      "providers:",
      "  openai:",
      "    baseUrl: https://imported.example/v1",
      "    api: openai-responses",
      "    auth: none",
      "    models:",
      "      - id: imported-model",
      "        name: Imported model",
      "",
    ].join("\n"));
    const omp = join(parent, "omp");
    await writeFile(omp, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write(JSON.stringify({ models: [{ provider: "openai", id: "imported-model", selector: "openai/imported-model" }] }));
} else if (args[0] === "config") {
  process.stdout.write(JSON.stringify(${JSON.stringify(ompConfig)}));
}
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const imported = await invoke(modelCommand, bundle, ["add", "openai/imported-model"], { from: "omp" });
      assert.equal(imported.result, 0, imported.stderr);
      assert.match(imported.stdout, /added openai\/imported-model/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    catalog = parseYaml(await readFile(join(bundle, "models.yml"), "utf8"));
    assert.deepEqual(catalog.providers.direct.models, [{ id: "direct-model", name: "direct-model" }]);
    assert.deepEqual(catalog.providers.openai.models, [{ id: "imported-model", name: "Imported model" }]);
    const listed = await invoke(modelCommand, bundle, ["list"]);
    assert.match(listed.stdout, /\* direct\/direct-model/);
    assert.match(listed.stdout, /  openai\/imported-model/);
  });
});

test("check accepts block scalars in schedules and reports YAML syntax errors as such", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");

    // A multi-line command is ordinary YAML and the cron runtime executes it,
    // so check must accept it too.
    await writeText(
      join(bundle, "schedules", "sync.yml"),
      'schedule: "*/10 * * * *"\nmissed: skip\ntimeout: 600\ncommand: |\n  set -eu\n  echo one\n  echo two\n',
    );
    const blockScalar = await validateBundle({ cwd: bundle });
    assert.equal(
      blockScalar.ok,
      true,
      blockScalar.errors.map((entry) => entry.message).join("\n"),
    );

    // A real syntax error must name YAML, not a schema field that happens to
    // be missing because the parser gave up early.
    await writeText(
      join(bundle, "schedules", "sync.yml"),
      'schedule: "*/10 * * * *"\nmissed: skip\n  command: "echo hi"\n bad indent\n',
    );
    const malformed = await validateBundle({ cwd: bundle });
    assert.equal(malformed.ok, false);
    assert(
      malformed.errors.some((entry) => entry.message.includes("not valid YAML")),
      `expected a YAML parse error, got: ${malformed.errors.map((entry) => entry.message).join("\n")}`,
    );
  });
});

test("check accepts root VCS metadata and Pumble derives the project agent id", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await mkdir(join(bundle, ".git"), { recursive: true });
    await seedModel(bundle, "alpha");
    for (const relativePath of [
      join("skills", "example-skill", "agents", "helper.md"),
      join("skills", "example-skill", "scripts", "prepare.ts"),
      join("skills", "example-skill", "references", "usage.md"),
      join("skills", "example-skill", "resources", "prompt.txt"),
    ]) {
      await writeText(join(bundle, relativePath), "skill resource\n");
    }
    const structural = await validateBundle({ cwd: bundle });
    assert.equal(structural.ok, true, structural.errors.map((entry) => entry.message).join("\n"));
    assert.equal(structural.agent.id, "alpha");
    assert.deepEqual(structural.agents.map((agent) => agent.id), ["alpha"]);

    const adapter = await invoke(generateCommand, bundle, ["adapter", "pumble"]);
    assert.equal(adapter.result, undefined);
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, runtimeEnv());
    const pumble = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(pumble.ok, true, pumble.errors.map((entry) => entry.message).join("\n"));
    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=[]\n`);
    const emptyAdapters = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(emptyAdapters.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS" && entry.message.includes("exactly one")
    ));
    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=\n`);
    const blankAdapters = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(blankAdapters.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS" && entry.message.includes("must not be empty")
    ));

    const registration = {
      adapterId: "pumble",
      callbackUrl: "http://127.0.0.1:8765/core/events",
      sharedSecret: "shared-secret",
    };
    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=${JSON.stringify([registration])}\n`);
    const unboundAdapters = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(unboundAdapters.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS[0].agentId" && entry.message.includes("is required")
    ));

    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=${JSON.stringify([{ ...registration, agentId: "stale" }])}\n`);
    const mismatchedAdapters = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(mismatchedAdapters.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS[0].agentId" && entry.message.includes("configured root agent 'alpha'")
    ));
    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=${JSON.stringify([{
      ...registration,
      callbackUrl: "http://127.0.0.1:8765/core/events/alpha",
      agentId: "alpha",
    }])}\n`);
    const mismatchedRoute = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(mismatchedRoute.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS[0].callbackUrl" && entry.message.includes("must target '/core/events'")
    ));
    await writeText(envPath, `${runtimeEnv()}OMP_ADAPTERS=${JSON.stringify([{
      ...registration,
      adapterId: "other-chat",
      agentId: "alpha",
    }])}\n`);
    const mismatchedAdapterId = await validateBundle({ cwd: bundle, envFile: envPath });
    assert(mismatchedAdapterId.errors.some((entry) =>
      entry.field === "OMP_ADAPTERS[0].adapterId" && entry.message.includes("must match PUMBLE_ADAPTER_ID 'pumble'")
    ));


    await writeText(envPath, `${runtimeEnv()}PUMBLE_AGENT_ID=stale\n`);
    const rejected = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(rejected.ok, false);
    assert(rejected.errors.some((entry) => entry.field === "PUMBLE_AGENT_ID"));
  });
});

test("check and Docker staging map agent components into OMP", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await invoke(generateCommand, bundle, ["subagent", "researcher"]);
    await seedModel(bundle, "alpha");
    const report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, true, report.errors.map((entry) => entry.message).join("\n"));

    const assets = join(parent, "assets");
    await createCanonicalAssetSource(assets);
    const contextPath = await stageDockerContext([report.agent], assets);
    try {
      assert.equal(await readFile(join(contextPath, "agent", "id"), "utf8"), "alpha\n");
      assert.equal(await exists(join(contextPath, "agent", ".omp", "AGENTS.md")), true);
      assert.equal(await exists(join(contextPath, "agent", ".omp", "config.yml")), true);
      assert.equal(await exists(join(contextPath, "agent", ".omp", "agents", "researcher.md")), true);
      assert.equal(await exists(join(contextPath, "agent", ".omp", "subagents")), false);
      assert.equal(await exists(join(contextPath, "agent", ".omp", "model.yml")), false);
      assert.equal(await exists(join(contextPath, "agent", ".git")), false);
      // The scaffolded inert example schedule is staged so the Dockerfile COPY resolves.
      assert.equal(await exists(join(contextPath, "schedules", "example-schedule.yml.example")), true);
    } finally {
      await removeDockerContext(contextPath);
    }
  });
});

test("check validates and Docker staging writes env-to-file secret manifests", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const configPath = join(bundle, "omp-bundler.yml");
    const writeFilesConfig = async (files) => {
      const lines = ["version: 1", "agent:", "  id: alpha"];
      if (files !== undefined) {
        lines.push("files:");
        for (const file of files) {
          lines.push(`  - env: ${file.env}`, `    path: ${file.path}`);
          if (file.mode !== undefined) lines.push(`    mode: "${file.mode}"`);
        }
      }
      lines.push("");
      await writeText(configPath, `${lines.join("\n")}`);
    };

    const validFiles = [
      { env: "GITHUB_SSH_KEY", path: "/root/.ssh/id_ed25519", mode: "0600" },
      { env: "SECOND_SECRET", path: "/root/.ssh/known_key" },
    ];
    await writeFilesConfig(validFiles);
    const valid = await validateBundle({ cwd: bundle });
    assert.equal(valid.ok, true, valid.errors.map((entry) => entry.message).join("\n"));
    assert.deepEqual(valid.credentialNames, ["GITHUB_SSH_KEY", "SECOND_SECRET"]);
    const checked = await invoke(checkCommand, bundle, []);
    assert.equal(checked.result, 0, checked.stderr);
    assert.match(checked.stdout, /Credential names present: GITHUB_SSH_KEY, SECOND_SECRET/);

    const assets = join(parent, "assets");
    await createCanonicalAssetSource(assets);
    const staged = await stageDockerContext([valid.agent], assets, undefined, valid.project.config.files);
    try {
      assert.deepEqual(
        JSON.parse(await readFile(join(staged, "agent", "files.json"), "utf8")),
        validFiles,
      );
    } finally {
      await removeDockerContext(staged);
    }

    const invalidCases = [
      {
        name: "relative path",
        files: [{ env: "KEY", path: "relative/key" }],
        field: "files[0].path",
        message: "absolute path",
      },
      {
        name: "persistent path",
        files: [{ env: "KEY", path: "/data/secret" }],
        field: "files[0].path",
        message: "under /data",
      },
      {
        name: "bad mode",
        files: [{ env: "KEY", path: "/root/secret", mode: "0999" }],
        field: "files[0].mode",
        message: "octal mode",
      },
      {
        name: "bad environment name",
        files: [{ env: "KEY-NAME", path: "/root/secret" }],
        field: "files[0].env",
        message: "valid environment variable",
      },
      {
        name: "duplicate path",
        files: [
          { env: "KEY_ONE", path: "/root/secret" },
          { env: "KEY_TWO", path: "/root/secret" },
        ],
        field: "files[1].path",
        message: "unique",
      },
    ];
    for (const invalid of invalidCases) {
      await writeFilesConfig(invalid.files);
      const report = await validateBundle({ cwd: bundle });
      assert.equal(report.ok, false, `${invalid.name} unexpectedly passed`);
      assert(
        report.errors.some((entry) =>
          entry.field === invalid.field && entry.message.includes(invalid.message)
        ),
        `${invalid.name}: ${report.errors.map((entry) => `${entry.field}: ${entry.message}`).join("; ")}`,
      );
    }

    await writeFilesConfig(undefined);
    const withoutFiles = await validateBundle({ cwd: bundle });
    assert.equal(withoutFiles.ok, true, withoutFiles.errors.map((entry) => entry.message).join("\n"));
    const emptyStaged = await stageDockerContext([withoutFiles.agent], assets, undefined, withoutFiles.project.config.files);
    try {
      assert.deepEqual(
        JSON.parse(await readFile(join(emptyStaged, "agent", "files.json"), "utf8")),
        [],
      );
    } finally {
      await removeDockerContext(emptyStaged);
    }
  });
});

test("check validates cron schedule files at the bundle root", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");

    // The scaffolded example stays inert and does not trip validation.
    const base = await validateBundle({ cwd: bundle });
    assert.equal(base.ok, true, base.errors.map((entry) => entry.message).join("\n"));

    await writeText(join(bundle, "schedules", "good.yml"), [
      'schedule: "0 9 * * 1-5"',
      "timezone: America/New_York",
      "missed: skip",
      'prompt: "Run the daily summary."',
      "",
    ].join("\n"));
    const good = await validateBundle({ cwd: bundle });
    assert.equal(good.ok, true, good.errors.map((entry) => entry.message).join("\n"));

    await writeText(join(bundle, "schedules", "command.yml"), [
      'schedule: "*/10 * * * *"',
      "missed: skip",
      'command: "printf ok"',
      "timeout: 300",
      "",
    ].join("\n"));
    const commandOnly = await validateBundle({ cwd: bundle });
    assert.equal(commandOnly.ok, true, commandOnly.errors.map((entry) => entry.message).join("\n"));

    await writeText(join(bundle, "schedules", "both.yml"), [
      'schedule: "0 9 * * *"',
      "missed: skip",
      'prompt: "Run it."',
      'command: "printf ok"',
      "",
    ].join("\n"));
    const both = await validateBundle({ cwd: bundle });
    assert(both.errors.some((entry) =>
      entry.message.includes("exactly one of prompt or command"),
    ));

    await writeText(join(bundle, "schedules", "neither.yml"), [
      'schedule: "0 9 * * *"',
      "missed: skip",
      "",
    ].join("\n"));
    const neither = await validateBundle({ cwd: bundle });
    assert(neither.errors.some((entry) =>
      entry.message.includes("exactly one of prompt or command"),
    ));

    await writeText(join(bundle, "schedules", "prompt-timeout.yml"), [
      'schedule: "0 9 * * *"',
      "missed: skip",
      'prompt: "Run it."',
      "timeout: 300",
      "",
    ].join("\n"));
    const promptTimeout = await validateBundle({ cwd: bundle });
    assert(promptTimeout.errors.some((entry) =>
      entry.field === "timeout" && entry.message.includes("only valid with command"),
    ));

    await writeText(join(bundle, "schedules", "bad-timeout.yml"), [
      'schedule: "0 9 * * *"',
      "missed: skip",
      'command: "printf ok"',
      "timeout: 0",
      "",
    ].join("\n"));
    const badTimeout = await validateBundle({ cwd: bundle });
    assert(badTimeout.errors.some((entry) =>
      entry.field === "timeout" && entry.message.includes("positive finite integer"),
    ));

    await writeText(join(bundle, "schedules", "bad-cron.yml"), [
      'schedule: "not a cron expr"',
      "missed: skip",
      'prompt: "x"',
      "",
    ].join("\n"));
    const badCron = await validateBundle({ cwd: bundle });
    assert(badCron.errors.some((entry) =>
      entry.field === "schedule" && entry.message.includes("5-field cron"),
    ));

    await writeText(join(bundle, "schedules", "bad-tz.yml"), [
      'schedule: "0 9 * * 1-5"',
      "timezone: Not/A/Zone",
      "missed: skip",
      'prompt: "x"',
      "",
    ].join("\n"));
    const badTz = await validateBundle({ cwd: bundle });
    assert(badTz.errors.some((entry) =>
      entry.field === "timezone" && entry.message.includes("IANA timezone"),
    ));

    await writeText(join(bundle, "schedules", "bad-missed.yml"), [
      'schedule: "0 9 * * 1-5"',
      "missed: later",
      'prompt: "x"',
      "",
    ].join("\n"));
    const badMissed = await validateBundle({ cwd: bundle });
    assert(badMissed.errors.some((entry) =>
      entry.field === "missed" && entry.message.includes("'skip' or 'catchUp'"),
    ));

    await writeText(join(bundle, "schedules", "no-prompt.yml"), [
      'schedule: "0 9 * * 1-5"',
      "missed: skip",
      'prompt: ""',
      "",
    ].join("\n"));
    const noPrompt = await validateBundle({ cwd: bundle });
    assert(noPrompt.errors.some((entry) =>
      entry.field === "prompt" && entry.message.includes("non-empty"),
    ));
  });
});

test("run settings select the next distinct free ports", async () => {
  const settings = {
    image: "bundle:local",
    corePort: 8787,
    adapterPort: 8765,
    dataVolume: "bundle-data",
    containerName: "bundle-data-service",
    bundleRoot: "/bundle",
  };
  const busy = new Set([8765, 8766, 8787]);
  const selected = await resolveAvailableRunSettings(settings, async (port) => !busy.has(port));
  assert.deepEqual(
    { adapterPort: selected.adapterPort, corePort: selected.corePort },
    { adapterPort: 8767, corePort: 8788 },
  );
  assert.match(
    runPreviewCommand(selected, "/bundle/runtime.env"),
    /--label io\.omp-bundler\.bundle-root=\/bundle/,
  );
  assert.match(runPreviewCommand(selected, "/bundle/runtime.env"), /docker run --rm -d /);
  assert.doesNotMatch(runPreviewCommand(selected, "/bundle/runtime.env", false), /docker run --rm -d /);
});

test("live adapter discovery follows the labeled foreground container", async () => {
  await withTempDirectory(async (parent) => {
    const docker = join(parent, "docker");
    await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  const name = args.at(-1);
  if (name === "bundle-data-service") process.stdout.write('"exited"\\n"/bundle"\\n');
  else if (name === "foreign-service") process.stdout.write('"running"\\n"/other-bundle"\\n');
  else if (name === "foreground-id") process.stdout.write('"running"\\n"/bundle"\\n');
  else process.exit(1);
  process.exit(0);
}
if (args[0] === "ps" && args.includes("label=io.omp-bundler.bundle-root=/bundle")) {
  process.stdout.write("foreground-id\\n");
  process.exit(0);
}
if (args[0] === "port" && args[1] === "foreground-id") {
  process.stdout.write("0.0.0.0:10001\\n[::]:10001\\n");
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      assert.equal(
        await discoverPublishedAdapterPort("/bundle", "bundle-data-service"),
        10001,
      );
      assert.equal(
        await discoverPublishedAdapterPort("/bundle", "foreign-service"),
        10001,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("run and status reject a same-name container owned by another bundle", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    await writeText(join(bundle, "runtime.env"), await readFile(join(bundle, "runtime.env.example"), "utf8"));
    await writeFile(join(parent, "docker"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stdout.write('"running"\\n"/other-bundle"\\n');
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      await assert.rejects(
        () => invoke(runCommand, bundle, []),
        /belongs to another bundle.*found \/other-bundle/,
      );
      await assert.rejects(
        () => invoke(statusCommand, bundle, []),
        /belongs to another bundle.*found \/other-bundle/,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("restart starts the service when no container exists", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    await writeText(join(bundle, "runtime.env"), await readFile(join(bundle, "runtime.env.example"), "utf8"));
    const capturePath = join(parent, "docker-run.json");
    await writeFile(join(parent, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stderr.write("No such container");
  process.exit(1);
}
if (args[0] === "run") {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const restarted = await invoke(restartCommand, bundle, []);
      assert.equal(restarted.result, 0, restarted.stderr);
      assert.match(restarted.stdout, /Started service bundle-data-service/);
      assert.equal((await readFile(capturePath, "utf8")).includes("--name"), true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("run retries when Docker loses a selected host port", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const racePort = await unusedTcpPort();
    const configPath = join(bundle, "omp-bundler.yml");
    await writeText(
      configPath,
      (await readFile(configPath, "utf8")).replace("adapterPort: 8765", `adapterPort: ${racePort}`),
    );
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, await readFile(join(bundle, "runtime.env.example"), "utf8"));

    const statePath = join(parent, "docker-state");
    const readyPath = join(parent, "holder-ready");
    const capturePath = join(parent, "docker-args.json");
    const holderSource = `const fs=require("node:fs");const server=require("node:net").createServer();server.listen(${racePort},"0.0.0.0",()=>fs.writeFileSync(${JSON.stringify(readyPath)},"ready"));`;
    await writeFile(join(parent, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const readyPath = ${JSON.stringify(readyPath)};
if (args[0] === "inspect") {
  process.stderr.write("No such container");
  process.exit(1);
}
if (args[0] !== "run") process.exit(1);
if (!fs.existsSync(statePath)) {
  const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holderSource)}], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  fs.writeFileSync(statePath, String(holder.pid));
  for (let index = 0; index < 200 && !fs.existsSync(readyPath); index += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  process.exit(fs.existsSync(readyPath) ? 1 : 2);
}
try { process.kill(Number(fs.readFileSync(statePath, "utf8")), "SIGTERM"); } catch {}
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args));
process.exit(0);
`, { mode: 0o755 });

    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const run = await invoke(runCommand, bundle, [], { "env-file": envPath });
      assert.equal(run.result, 0, run.stderr);
      assert.match(run.stderr, /selected host port became busy during Docker startup/);
      const dockerArgs = JSON.parse(await readFile(capturePath, "utf8"));
      const adapterMapping = dockerArgs.find((value) => value.endsWith(":8765"));
      assert(adapterMapping);
      assert.notEqual(Number(adapterMapping.split(":")[0]), racePort);
      assert.match(run.stdout, new RegExp(`Agent endpoint \\(available once listening; not a readiness check\\): http://localhost:${adapterMapping.split(":")[0]}/`));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (await exists(statePath)) {
        try { process.kill(Number(await readFile(statePath, "utf8")), "SIGTERM"); } catch {}
      }
    }
  });
});

test("run and tui select one root endpoint without agent id overrides", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const configPath = join(bundle, "omp-bundler.yml");
    await writeText(configPath, (await readFile(configPath, "utf8")).replace("adapterPort: 8765", "adapterPort: 9999"));
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, await readFile(join(bundle, "runtime.env.example"), "utf8"));

    const target = await resolveTuiTarget(commandArgs([], {}), bundle, async () => undefined);
    assert.deepEqual(target, { endpoint: "http://localhost:9999/v1/agents/alpha", token: "" });
    const liveTarget = await resolveTuiTarget(commandArgs([], {}), bundle, async () => 10001);
    assert.equal(liveTarget.endpoint, "http://localhost:10001/v1/agents/alpha");
    const exact = await resolveTuiTarget(commandArgs([], { endpoint: "http://localhost:9999/v1/agents/alpha" }), bundle);
    assert.equal(exact.endpoint, "http://localhost:9999/v1/agents/alpha");

    const docker = join(parent, "docker");
    await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stderr.write("No such container");
  process.exit(1);
}
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const run = await invoke(runCommand, bundle, [], { "env-file": envPath });
      assert.equal(run.result, 0, run.stderr);
      const lines = run.stdout.split(/\r?\n/).filter((line) => line.startsWith("Agent endpoint") || line.startsWith("TUI:"));
      assert.deepEqual(lines, [
        "Agent endpoint (available once listening; not a readiness check): http://localhost:9999/v1/agents/alpha",
        "TUI: omp-bundler tui",
      ]);
      assert.doesNotMatch(run.stdout, /--id/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await assert.rejects(
      () => invoke(tuiCommand, bundle, [], { id: "alpha" }),
      /unknown option/,
    );
  });
});

test("readline chat sends a real turn and renders the root agent response", async () => {
  const capture = captureIO();
  capture.io.stdin = Readable.from(["hello agent\n", "/quit\n"]);
  const requests = [];
  const result = await runReadlineChat(
    { endpoint: "http://localhost:8765/v1/agents/alpha", token: "secret-token" },
    handlerContext(process.cwd(), capture.io),
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ text: "hello from alpha" }), { status: 200 });
    },
  );
  assert.equal(result, 0);
  assert.match(capture.stdout(), /agent> hello from alpha/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.authorization, "Bearer secret-token");
});

test("readline chat incrementally parses arbitrarily fragmented UTF-8 SSE frames", async () => {
  const capture = captureIO();
  capture.io.stdin = Readable.from(["hello agent\n", "/quit\n"]);
  const source = [
    "event: accepted\r\n",
    "data: {\"conversationId\":\"conversation-1\"}\r\n\r\n",
    "event: progress\n",
    "data: {\"status\":\"working\"}\n\n",
    "event: delta\r\n",
    "data: {\"text\":\"caf\u00e9 \"}\r\n\r\n",
    "event: delta\n",
    "data: {\"text\":\"done\"}\n\n",
    "event: completed\r\n",
    "data: {\"text\":\"caf\u00e9 done\"}\r\n\r\n",
  ].join("");
  const bytes = new TextEncoder().encode(source);
  const requests = [];
  await runReadlineChat(
    { endpoint: "http://localhost:8765/v1/agents/alpha", token: "secret-token" },
    handlerContext(process.cwd(), capture.io),
    async (url, options) => {
      requests.push({ url, options });
      return sseResponse(source, [...bytes.keys()].slice(1));
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.accept, "text/event-stream");
  assert.equal(requests[0].options.headers.authorization, "Bearer secret-token");
  assert.equal(requests[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].options.body), { message: "hello agent" });
  assert.match(capture.stdout(), /agent> café done\n\n/);
  assert.equal((capture.stdout().match(/agent> /g) ?? []).length, 1);
  assert.doesNotMatch(capture.stdout(), /working|conversation-1|corrected/);
});

test("readline chat reconciles completed SSE output without a second prompt", async () => {
  const capture = captureIO();
  capture.io.stdin = Readable.from(["hello\n", "/quit\n"]);
  await runReadlineChat(
    { endpoint: "http://localhost:8765/v1/agents/alpha" },
    handlerContext(process.cwd(), capture.io),
    async () => sseResponse(
      "event: delta\ndata: {\"text\":\"hel\"}\n\nevent: completed\ndata: {\"text\":\"hello\"}\n\n",
    ),
  );
  assert.match(capture.stdout(), /agent> hello\n\n/);
  assert.equal((capture.stdout().match(/agent> /g) ?? []).length, 1);
  assert.doesNotMatch(capture.stdout(), /corrected/);
});

test("readline chat visibly corrects mismatched completed SSE output", async () => {
  const capture = captureIO();
  capture.io.stdin = Readable.from(["hello\n", "/quit\n"]);
  await runReadlineChat(
    { endpoint: "http://localhost:8765/v1/agents/alpha" },
    handlerContext(process.cwd(), capture.io),
    async () => sseResponse(
      "event: delta\ndata: {\"text\":\"partial\"}\n\nevent: completed\ndata: {\"text\":\"replacement\"}\n\n",
    ),
  );
  assert.match(capture.stdout(), /agent> partial\n\[agent response corrected\]\nreplacement\n\n/);
  assert.equal((capture.stdout().match(/agent> /g) ?? []).length, 1);
});

test("readline chat reports terminal, malformed, and truncated SSE failures", async () => {
  const cases = [
    ["event: error\ndata: {\"message\":\"turn failed\"}\n\n", /Error: turn failed/],
    ["event: accepted\ndata: {}\n\n", /Error: agent event stream protocol error: stream ended before a completed or error event/],
  ];
  for (const [source, expected] of cases) {
    const capture = captureIO();
    capture.io.stdin = Readable.from(["hello\n", "/quit\n"]);
    await runReadlineChat(
      { endpoint: "http://localhost:8765/v1/agents/alpha" },
      handlerContext(process.cwd(), capture.io),
      async () => sseResponse(source),
    );
    assert.match(capture.stderr(), expected);
  }
});

test("readline chat detaches a Ctrl-C aborted SSE request without an error", async () => {
  const capture = captureIO();
  capture.io.stdin = new Readable({ read() {} });
  capture.io.stdin.isTTY = true;
  capture.io.stdin.setRawMode = () => {};
  capture.io.stdout.isTTY = true;
  capture.io.stdout.columns = 80;
  capture.io.stdin.push("hello\n");
  let cancelled = false;
  await runReadlineChat(
    { endpoint: "http://localhost:8765/v1/agents/alpha" },
    handlerContext(process.cwd(), capture.io),
    async () => {
      setTimeout(() => {
        capture.io.stdin.emit("keypress", "\u0003", { name: "c", ctrl: true, meta: false, shift: false });
      }, 0);
      return new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  );
  assert.equal(cancelled, true);
  assert.doesNotMatch(capture.stderr(), /Error:/);
});
