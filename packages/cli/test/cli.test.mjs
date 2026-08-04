import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
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
  serviceCommand,
  tuiCommand,
  PACKAGE_ASSET_PATHS,
  removeDockerContext,
  setModelCommand,
  stageDockerContext,
  stagePackagedAssets,
} from "../src/index.ts";
import {
  buildPreviewCommand,
  resolveBuildTag,
  resolveTuiTarget,
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
  const ambientExtension = join(root, "ambient-ingest-extension.ts");
  await mkdir(binDir, { recursive: true });
  await writeText(join(buildDir, "render-models.ts"), "export {};\n");
  await writeText(join(homeDir, ".omp", "agent", "models.yml.tmpl"), "{}\n");
  await writeText(orphanSweep, "export {};\n");
  await writeText(coreServer, "export {};\n");
  await writeText(httpServer, "export {};\n");
  await writeText(pumbleServer, "export {};\n");
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
  });
  writeFileSync(process.env.ENTRYPOINT_CAPTURE_PATH + ".tmp", capture);
  renameSync(process.env.ENTRYPOINT_CAPTURE_PATH + ".tmp", process.env.ENTRYPOINT_CAPTURE_PATH);
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

/** Write the root model.yml used by one-agent bundles. */
async function seedModel(root, _agentId, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? "https://api.test.example/v1";
  const dialect = overrides.dialect ?? "openai-responses";
  const model = overrides.model ?? "gpt-test";
  const apiKey = overrides.apiKey ?? "";
  await writeText(join(root, "model.yml"), [
    "version: 1",
    `baseUrl: ${quoteYamlValue(baseUrl)}`,
    `dialect: ${dialect}`,
    `model: ${quoteYamlValue(model)}`,
    `apiKey: ${apiKey === "" ? '""' : quoteYamlValue(apiKey)}`,
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
        "AGENTS.md",
        "config.yml",
        "subagents",
        "commands",
        "extensions",
        "skills",
        "tools",
      ]),
    );
    for (const relativePath of [
      join("subagents", "example-subagent.md.example"),
      join("commands", "example-command.md.example"),
      join("extensions", "example-extension.ts.example"),
      join("skills", "example-skill", "SKILL.md.example"),
      join("tools", "example-tool.ts.example"),
    ]) {
      assert.equal(await exists(join(derived, relativePath)), true, relativePath);
    }
    assert.equal(await exists(join(derived, "model.yml")), false);
    assert.deepEqual(
      parseYaml(await readFile(join(derived, "omp-bundler.yml"), "utf8"))
        .agent,
      { id: "derived" },
    );
    const generatedReadme = await readFile(join(derived, "README.md"), "utf8");
    assert.match(generatedReadme, /\.example.*inactive/);
    assert.match(generatedReadme, /omp-bundler generate skill meeting-notes/);

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
    ];
    for (const [kind, name, relativePath] of components) {
      await invoke(generateCommand, bundle, [kind, name]);
      assert.equal(await exists(join(bundle, relativePath)), true);
    }
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

test("set-model targets root model.yml and accepts a provider/model positional import", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    const direct = await invoke(setModelCommand, bundle, [], {
      "base-url": "https://direct.example/v1",
      dialect: "openai-responses",
      model: "direct-model",
      "api-key": "",
    });
    assert.equal(direct.result, 0, direct.stderr);
    assert.equal(await exists(join(bundle, "model.yml")), true);
    assert.equal(await exists(join(bundle, "models")), false);
    assert.match(await readFile(join(bundle, "model.yml"), "utf8"), /model: direct-model/);

    const ompConfig = join(parent, "omp-config");
    await writeText(join(ompConfig, "models.yml"), [
      "providers:",
      "  openai:",
      "    baseUrl: https://imported.example/v1",
      "    api: openai-responses",
      "    auth: none",
      "    models:",
      "      - id: imported-model",
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
      const imported = await invoke(setModelCommand, bundle, ["openai/imported-model"]);
      assert.equal(imported.result, 0, imported.stderr);
      assert.match(imported.stdout, /imported openai\/imported-model from OMP/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const model = await readFile(join(bundle, "model.yml"), "utf8");
    assert.match(model, /baseUrl: https:\/\/imported\.example\/v1/);
    assert.match(model, /model: imported-model/);
    assert.doesNotMatch(model, /direct-model/);
  });
});

test("check accepts root VCS metadata and Pumble derives the project agent id", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { id: "alpha" });
    const bundle = join(parent, "bundle");
    await mkdir(join(bundle, ".git"), { recursive: true });
    await seedModel(bundle, "alpha");
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

    await writeText(envPath, `${runtimeEnv()}PUMBLE_AGENT_ID=stale\n`);
    const rejected = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(rejected.ok, false);
    assert(rejected.errors.some((entry) => entry.field === "PUMBLE_AGENT_ID"));
  });
});

test("check and Docker staging validate one root agent and translate subagents", async () => {
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
    } finally {
      await removeDockerContext(contextPath);
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

    const target = await resolveTuiTarget(commandArgs([], {}), bundle);
    assert.deepEqual(target, { endpoint: "http://localhost:9999/v1/agents/alpha", token: "" });
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
