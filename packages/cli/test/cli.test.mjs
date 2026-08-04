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
  agentCommand,
  buildCommand,
  checkCommand,
  applyFilePlan,
  createFilePlan,
  discoverAgents,
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
  migrateCommand,
  resolveTuiTarget,
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
  await writeFile(
    join(binDir, "bun"),
    `#!${process.execPath}
const { copyFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0]?.endsWith("/render-models.ts")) {
  const input = args[args.indexOf("--input") + 1];
  const output = args[args.indexOf("--output") + 1];
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(input, output);
}
`,
    { encoding: "utf8", mode: 0o755 },
  );

  return {
    run(agentsSrc, dataDir) {
      const { promise, resolve: resolveRun, reject: rejectRun } = Promise.withResolvers();
      const env = {
        ...process.env,
        AGENTS_SRC: agentsSrc,
        OMP_DATA_DIR: dataDir,
        OMP_BUILD_DIR: buildDir,
        OMP_ORPHAN_SWEEP: orphanSweep,
        OMP_CORE_SERVER: coreServer,
        OMP_HTTP_SERVER: httpServer,
        OMP_PUMBLE_SERVER: pumbleServer,
        OMP_AMBIENT_EXTENSION: ambientExtension,
        OMP_CHILD_REGISTRY_PATH: join(dataDir, "child-registry.json"),
        OMP_ADAPTERS: "[]",
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      delete env.OMP_AUTH_BROKER_URL;
      delete env.OMP_AUTH_BROKER_TOKEN;
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
      child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
      return promise;
    },
  };
}

async function createBakedAgents(root, name, agents) {
  const source = join(root, name);
  for (const [agentId, config] of Object.entries(agents)) {
    await writeText(join(source, agentId, ".omp", "config.yml"), config);
  }
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

function runtimeEnv(agentId = "alpha") {
  return [
    "OMP_BUNDLER_ADAPTER=pumble",
    "PUMBLE_APP_ID=app",
    "PUMBLE_APP_CLIENT_SECRET=client-secret",
    "PUMBLE_APP_KEY=app-key",
    "PUMBLE_APP_SIGNING_SECRET=signing-secret",
    "PUMBLE_PUBLIC_BASE_URL=http://localhost:3000",
    "PUMBLE_CORE_SHARED_SECRET=shared-secret",
    `PUMBLE_AGENT_ID=${agentId}`,
    "",
  ].join("\n");
}

function quoteYamlValue(value) {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** Write a valid <agentId>.yml under models/ for an effective agent. */
async function seedModel(root, agentId, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? "https://api.test.example/v1";
  const dialect = overrides.dialect ?? "openai-responses";
  const model = overrides.model ?? "gpt-test";
  const apiKey = overrides.apiKey ?? "";
  await writeText(join(root, "models", `${agentId}.yml`), [
    "version: 1",
    `baseUrl: ${quoteYamlValue(baseUrl)}`,
    `dialect: ${dialect}`,
    `model: ${quoteYamlValue(model)}`,
    `apiKey: ${apiKey === "" ? '""' : quoteYamlValue(apiKey)}`,
    "",
  ].join("\n"));
}

/** Run an async callback with process.env.EDITOR pointed at a fake node editor. */
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

test("entrypoint removes stale durable .omp trees while preserving workspaces", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "data");
    const imageV1 = await createBakedAgents(root, "image-v1", {
      old: "old-image\n",
      current: "current-image-v1\n",
    });
    const first = await harness.run(imageV1, dataDir);
    assert.equal(first.code, 0, first.stderr);

    const oldWorkspace = join(dataDir, "agents", "old", "workspace.txt");
    const currentWorkspace = join(dataDir, "agents", "current", "notes.txt");
    await writeText(oldWorkspace, "keep old workspace\n");
    await writeText(currentWorkspace, "keep current workspace\n");

    const imageV2 = await createBakedAgents(root, "image-v2", {
      current: "current-image-v2\n",
    });
    const second = await harness.run(imageV2, dataDir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await exists(join(dataDir, "agents", "old")), true);
    assert.equal(await exists(join(dataDir, "agents", "old", ".omp")), false);
    assert.equal(await readFile(oldWorkspace, "utf8"), "keep old workspace\n");
    assert.equal(
      await readFile(join(dataDir, "agents", "current", ".omp", "config.yml"), "utf8"),
      "current-image-v2\n",
    );
    assert.equal(await readFile(currentWorkspace, "utf8"), "keep current workspace\n");
  });
});

test("entrypoint rejects durable agent and .omp symlinks", async () => {
  await withTempDirectory(async (root) => {
    const harness = await createEntrypointHarness(root);
    const dataDir = join(root, "data");
    const agentsDir = join(dataDir, "agents");
    const outside = join(root, "outside");
    await writeText(join(outside, "sentinel.txt"), "outside\n");
    await mkdir(agentsDir, { recursive: true });
    await symlink(outside, join(agentsDir, "unsafe"));
    const image = await createBakedAgents(root, "image", { current: "current\n" });

    const agentLink = await harness.run(image, dataDir);
    assert.notEqual(agentLink.code, 0);
    assert.match(agentLink.stderr, /must not be a symlink/);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside\n");

    await rm(join(agentsDir, "unsafe"), { force: true });
    await mkdir(join(agentsDir, "unsafe"), { recursive: true });
    await symlink(outside, join(agentsDir, "unsafe", ".omp"));
    const ompLink = await harness.run(image, dataDir);
    assert.notEqual(ompLink.code, 0);
    assert.match(ompLink.stderr, /must not be a symlink/);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside\n");
  });
});

test("new creates empty and full trees, generators cover every surface, and collisions stay safe", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["empty"]);
    await invoke(newCommand, parent, ["full"], { agent: "alpha" });

    assert.deepEqual(
      new Set(await readdir(join(parent, "empty"))),
      new Set([".gitignore", "README.md", "omp-bundler.yml", "runtime.env.example", "agents"]),
    );
    assert.equal(await exists(join(parent, "empty", "agents", ".gitkeep")), true);
    assert.equal(await exists(join(parent, "full", "agents", "alpha", "AGENTS.md")), true);
    assert.match(
      await readFile(join(parent, "full", "runtime.env.example"), "utf8"),
      /^OMP_BUNDLER_ADAPTER=http$/m,
    );
    assert.equal(await exists(join(parent, "full", "agents", "alpha", "config.yml")), true);
    for (const surface of ["agents", "commands", "extensions", "skills", "tools"]) {
      assert.equal(await exists(join(parent, "full", "agents", "alpha", surface)), true);
    }

    await assert.rejects(
      () => invoke(newCommand, parent, ["full"]),
      /bundle destination already exists/,
    );

    await invoke(generateCommand, join(parent, "empty"), ["agent", "later"]);
    assert.equal(await exists(join(parent, "empty", "agents", ".gitkeep")), false);
    assert.equal(await exists(join(parent, "empty", "agents", "later", "config.yml")), true);

    const components = [
      ["skill", "knowledge-base", join("skills", "knowledge-base", "SKILL.md")],
      ["command", "summarize", join("commands", "summarize.md")],
      ["tool", "lookup-record", join("tools", "lookup-record.ts")],
      ["extension", "lifecycle-log", join("extensions", "lifecycle-log.ts")],
      ["subagent", "researcher", join("agents", "researcher.md")],
    ];
    for (const [kind, name, relativePath] of components) {
      await invoke(generateCommand, join(parent, "full"), [kind, "alpha", name]);
      assert.equal(
        await exists(join(parent, "full", "agents", "alpha", relativePath)),
        true,
      );
    }

    const previewPath = join(parent, "full", "agents", "alpha", "tools", "preview.ts");
    const preview = await invoke(
      generateCommand,
      join(parent, "full"),
      ["tool", "alpha", "preview"],
      { "dry-run": true },
    );
    assert.match(preview.stdout, /would create/);
    assert.equal(await exists(previewPath), false);
    await assert.rejects(
      () => invoke(generateCommand, join(parent, "full"), ["tool", "alpha", "lookup-record"]),
      /refusing to overwrite existing path/,
    );
    await assert.rejects(
      () => invoke(generateCommand, join(parent, "full"), ["command", "alpha", "../escape"]),
      /unsafe/,
    );
  });
});

test("mutation plans reject symlinked bundle, agents, component, and env paths", async () => {
  await withTempDirectory(async (parent) => {
    const realBundles = join(parent, "real-bundles");
    const linkedBundles = join(parent, "linked-bundles");
    await mkdir(realBundles);
    await symlink(realBundles, linkedBundles, "dir");
    await assert.rejects(
      () => invoke(newCommand, parent, [join(linkedBundles, "bundle")]),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundles, "bundle")), false);

    await invoke(newCommand, parent, ["agents-dir"]);
    const agentsBundle = join(parent, "agents-dir");
    const externalAgents = join(parent, "external-agents");
    await mkdir(externalAgents);
    await rm(join(agentsBundle, "agents"), { recursive: true });
    await symlink(externalAgents, join(agentsBundle, "agents"), "dir");
    await assert.rejects(
      () => invoke(generateCommand, agentsBundle, ["agent", "alpha"]),
      /symlinked path component/,
    );
    assert.deepEqual(await readdir(externalAgents), []);

    await invoke(newCommand, parent, ["surfaces"], { agent: "alpha" });
    const surfacesBundle = join(parent, "surfaces");
    const componentCases = [
      ["skill", "skills", "knowledge-base"],
      ["command", "commands", "summarize"],
      ["tool", "tools", "lookup-record"],
      ["extension", "extensions", "lifecycle-log"],
      ["subagent", "agents", "researcher"],
    ];
    for (const [kind, surface, name] of componentCases) {
      const componentSurface = join(surfacesBundle, "agents", "alpha", surface);
      const externalSurface = join(parent, `${kind}-surface`);
      await mkdir(externalSurface);
      await rm(componentSurface, { recursive: true });
      await symlink(externalSurface, componentSurface, "dir");
      await assert.rejects(
        () => invoke(generateCommand, surfacesBundle, [kind, "alpha", name]),
        /symlinked path component/,
      );
      assert.deepEqual(await readdir(externalSurface), []);
    }

    const runtimePath = join(surfacesBundle, "runtime.env.example");
    const externalRuntime = join(parent, "external-runtime.env.example");
    const originalRuntime = await readFile(runtimePath, "utf8");
    await writeFile(externalRuntime, originalRuntime, "utf8");
    await rm(runtimePath);
    await symlink(externalRuntime, runtimePath, "file");
    await assert.rejects(
      () => invoke(generateCommand, surfacesBundle, ["adapter", "pumble"], { agent: "alpha" }),
      /symlinked path component/,
    );
    assert.equal(await readFile(externalRuntime, "utf8"), originalRuntime);
  });
});
test("generate, model, rename, and destroy reject an existing bundle reached through a symlinked ancestor", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, [join("real-bundles", "bundle")], { agent: "alpha" });
    const realBundle = join(parent, "real-bundles", "bundle");
    await symlink(join(parent, "real-bundles"), join(parent, "linked-bundles"), "dir");
    const bundle = join(parent, "linked-bundles", "bundle");

    await assert.rejects(
      () => invoke(generateCommand, bundle, ["agent", "beta"]),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundle, "agents", "beta")), false);

    await assert.rejects(
      () => invoke(generateCommand, bundle, ["skill", "alpha", "preview"]),
      /symlinked path component/,
    );
    assert.equal(
      await exists(join(realBundle, "agents", "alpha", "skills", "preview")),
      false,
    );

    await assert.rejects(
      () => invoke(setModelCommand, bundle, ["alpha"], { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "acme/model-v1" }),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundle, "models", "alpha.yml")), false);

    await assert.rejects(
      () => invoke(agentCommand, bundle, ["rename", "alpha", "renamed"]),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundle, "agents", "renamed")), false);
    assert.equal(await exists(join(realBundle, "agents", "alpha")), true);

    await invoke(generateCommand, realBundle, ["skill", "alpha", "temporary"]);
    const skillPath = join(realBundle, "agents", "alpha", "skills", "temporary", "SKILL.md");
    await assert.rejects(
      () => invoke(destroyCommand, bundle, ["skill", "alpha", "temporary"], { yes: true }),
      /symlinked path component/,
    );
    assert.equal(await exists(skillPath), true);

    await assert.rejects(
      () => invoke(destroyCommand, bundle, ["agent", "alpha"], { yes: true }),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundle, "agents", "alpha")), true);

    // A nested invocation cwd inside the symlinked bundle is rejected too,
    // because the guard compares the physical and lexical bundle roots.
    const nested = join(bundle, "agents", "alpha");
    await assert.rejects(
      () => invoke(generateCommand, nested, ["tool", "alpha", "lookup-record"]),
      /symlinked path component/,
    );
    await assert.rejects(
      () => invoke(setModelCommand, nested, ["alpha"], { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "acme/model-v1" }),
      /symlinked path component/,
    );

    assert.equal(
      await exists(join(realBundle, "agents", "alpha", "tools", "lookup-record.ts")),
      false,
    );

    // Grandparent symlinks are caught too: the physical root differs from the
    // lexical root regardless of how far above the bundle the link sits.
    await invoke(newCommand, parent, [join("real-bundles", "sub", "grand")], { agent: "alpha" });
    const grand = join(parent, "linked-bundles", "sub", "grand");
    await assert.rejects(
      () => invoke(generateCommand, grand, ["skill", "alpha", "deep"]),
      /symlinked path component/,
    );
    assert.equal(
      await exists(join(parent, "real-bundles", "sub", "grand", "agents", "alpha", "skills", "deep")),
      false,
    );

    // Direct plan creation on an existing root under a symlinked ancestor is
    // rejected before any write is staged.
    await assert.rejects(
      () => createFilePlan(bundle, [{ path: "created.txt", content: "must not escape\n" }]),
      /symlinked path component/,
    );
    assert.equal(await exists(join(realBundle, "created.txt")), false);

    // Applying an already-planned file against a root whose ancestor became a
    // symlink after planning is rejected by the apply-time recheck.
    await mkdir(join(parent, "swap-other", "bundle"), { recursive: true });
    await invoke(newCommand, parent, [join("swap-sub", "bundle")], { agent: "alpha" });
    const swapPlan = await createFilePlan(join(parent, "swap-sub", "bundle"), [{
      path: join("agents", "alpha", "notes.txt"),
      content: "safe\n",
    }]);
    await rm(join(parent, "swap-sub"), { recursive: true });
    await symlink(join(parent, "swap-other"), join(parent, "swap-sub"), "dir");
    await assert.rejects(
      () => applyFilePlan(swapPlan),
      /symlinked path component/,
    );
    assert.equal(await exists(join(parent, "swap-other", "bundle", "agents", "alpha", "notes.txt")), false);
  });
});

test("mutation commands pass on a physical bundle path with a macOS-style alias above the trusted cwd", async () => {
  await withTempDirectory(async (parent) => {
    // The canonicalized temp root is physical, matching production
    // process.cwd(); a Darwin-style alias (like /var above /var/folders)
    // above the physical path is never part of the bundle path, so the
    // realpath root guard passes.
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");

    await invoke(generateCommand, bundle, ["skill", "alpha", "preview"]);
    assert.equal(
      await exists(join(bundle, "agents", "alpha", "skills", "preview", "SKILL.md")),
      true,
    );

    await invoke(setModelCommand, bundle, ["alpha"], { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "acme/model-v1" });
    assert.match(await readFile(join(bundle, "models", "alpha.yml"), "utf8"), /model: acme\/model-v1/);

    await invoke(agentCommand, bundle, ["rename", "alpha", "renamed"]);
    assert.equal(await exists(join(bundle, "agents", "renamed")), true);

    await invoke(generateCommand, bundle, ["skill", "renamed", "temporary"]);
    const skillPath = join(bundle, "agents", "renamed", "skills", "temporary", "SKILL.md");
    await invoke(destroyCommand, bundle, ["skill", "renamed", "temporary"], { yes: true });
    assert.equal(await exists(skillPath), false);
  });
});

test("applyFilePlan rechecks symlinked components after planning", async () => {
  await withTempDirectory(async (parent) => {
    const bundle = join(parent, "bundle");
    const external = join(parent, "external");
    await mkdir(bundle);
    await mkdir(external);
    const plan = await createFilePlan(bundle, [{
      path: join("nested", "created.txt"),
      content: "must not escape\n",
    }]);
    await symlink(external, join(bundle, "nested"), "dir");
    await assert.rejects(
      () => applyFilePlan(plan),
      /symlinked path component/,
    );
    assert.equal(await exists(join(external, "created.txt")), false);
  });
});

test("rename and destroy rollback late env failures without source or temp changes", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["rename-failure"], { agent: "alpha" });
    const renameBundle = join(parent, "rename-failure");
    await invoke(generateCommand, renameBundle, ["adapter", "pumble"], { agent: "alpha" });
    const renameSource = join(renameBundle, "agents", "alpha");
    const renameDestination = join(renameBundle, "agents", "renamed");
    const renameEnv = join(renameBundle, "runtime.env.example");
    await writeText(join(renameSource, "notes.txt"), "preserve this source\n");
    const renameSourceBefore = await snapshotTree(renameSource);
    const renameEnvBefore = await readFile(renameEnv);
    await chmod(renameEnv, 0o444);
    await assert.rejects(
      () => invoke(agentCommand, renameBundle, ["rename", "alpha", "renamed"]),
      /EACCES|permission denied/i,
    );
    assert.deepEqual(await snapshotTree(renameSource), renameSourceBefore);
    assert.deepEqual(await readFile(renameEnv), renameEnvBefore);
    assert.equal(await exists(renameDestination), false);
    assert.deepEqual(await transactionArtifacts(renameBundle), []);
    await chmod(renameEnv, 0o644);

    await invoke(newCommand, parent, ["destroy-failure"], { agent: "alpha" });
    const destroyBundle = join(parent, "destroy-failure");
    await invoke(generateCommand, destroyBundle, ["adapter", "pumble"], { agent: "alpha" });
    const destroySource = join(destroyBundle, "agents", "alpha");
    const destroyEnv = join(destroyBundle, "runtime.env.example");
    await writeText(join(destroySource, "notes.txt"), "preserve this source\n");
    const destroySourceBefore = await snapshotTree(destroySource);
    const destroyEnvBefore = await readFile(destroyEnv);
    await chmod(destroyEnv, 0o444);
    await assert.rejects(
      () => invoke(destroyCommand, destroyBundle, ["agent", "alpha"], { yes: true }),
      /EACCES|permission denied/i,
    );
    assert.deepEqual(await snapshotTree(destroySource), destroySourceBefore);
    assert.deepEqual(await readFile(destroyEnv), destroyEnvBefore);
    assert.deepEqual(await transactionArtifacts(destroyBundle), []);
    await chmod(destroyEnv, 0o644);
  });
});

test("Pumble generation is idempotent and agent rename or destroy keeps model state consistent", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const envExample = join(bundle, "runtime.env.example");

    await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    const before = await readFile(envExample, "utf8");
    assert.match(before, /^OMP_BUNDLER_ADAPTER=pumble$/m);
    assert.match(before, /PUMBLE_AGENT_ID=alpha/);
    const repeated = await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    assert.match(repeated.stdout, /no changes/);
    assert.equal(await readFile(envExample, "utf8"), before);

    await writeText(envExample, before.replace("PUMBLE_AGENT_ID=alpha", "PUMBLE_AGENT_ID=other"));
    await assert.rejects(
      () => invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" }),
      /already binds PUMBLE_AGENT_ID to 'other'/,
    );
    await writeText(envExample, before);

    await invoke(setModelCommand, bundle, ["alpha"], { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "acme/model-v1" });
    const modelPath = join(bundle, "models", "alpha.yml");
    assert.match(await readFile(modelPath, "utf8"), /model: acme\/model-v1/);
    await writeText(modelPath, `${await readFile(modelPath, "utf8")}# preserve \${OMP_MODEL_ALPHA_API_KEY}\n`);
    await writeText(join(bundle, "agents", "alpha", "notes.txt"), "alpha custom state\n");
    const ignoredRuntime = join(bundle, "runtime.env");
    await writeText(ignoredRuntime, "PUMBLE_AGENT_ID=alpha\n");

    const renamed = await invoke(agentCommand, bundle, ["rename", "alpha", "renamed"]);
    assert.match(renamed.stdout, /manual reference/);
    assert.equal(await exists(join(bundle, "models", "alpha.yml")), false);
    assert.equal(await exists(join(bundle, "models", "renamed.yml")), true);
    const renamedModel = await readFile(join(bundle, "models", "renamed.yml"), "utf8");
    assert.match(renamedModel, /model: acme\/model-v1/);
    assert.match(renamedModel, /apiKey: "\$\{OMP_MODEL_RENAMED_API_KEY\}"/);
    assert.match(renamedModel, /# preserve \$\{OMP_MODEL_ALPHA_API_KEY\}/);
    assert.equal(await exists(join(bundle, "agents", "alpha")), false);
    assert.equal(await exists(join(bundle, "agents", "renamed", "notes.txt")), true);
    assert.equal(await readFile(join(bundle, "agents", "renamed", "notes.txt"), "utf8"), "alpha custom state\n");
    assert.match(await readFile(envExample, "utf8"), /PUMBLE_AGENT_ID=renamed/);
    assert.equal(await readFile(ignoredRuntime, "utf8"), "PUMBLE_AGENT_ID=alpha\n");
    const renamedEnv = await readFile(envExample, "utf8");
    assert.doesNotMatch(renamedEnv, /Model connection for alpha|OMP_MODEL_ALPHA_API_KEY/);
    assert.match(renamedEnv, /Model connection for renamed/);
    await writeText(
      envExample,
      `${renamedEnv.replace("PUMBLE_AGENT_ID=renamed", "PUMBLE_AGENT_ID=renamed # primary")}\n# User section\nSENTINEL=keep\n`,
    );
    await invoke(destroyCommand, bundle, ["agent", "renamed"], { yes: true });
    assert.equal(await exists(join(bundle, "agents", "renamed")), false);
    assert.equal(await exists(join(bundle, "models", "renamed.yml")), false);
    const destroyedEnv = await readFile(envExample, "utf8");
    assert.doesNotMatch(destroyedEnv, /PUMBLE_|Model connection for renamed|OMP_MODEL_RENAMED_API_KEY/);
    assert.match(destroyedEnv, /^OMP_BUNDLER_ADAPTER=http$/m);
    assert.match(destroyedEnv, /SENTINEL=keep/);
    assert.equal((await validateBundle({ cwd: bundle, envFile: envExample })).ok, true);
    assert.equal(await readFile(ignoredRuntime, "utf8"), "PUMBLE_AGENT_ID=alpha\n");
    assert.deepEqual(await transactionArtifacts(bundle), []);
  });
});

test("destructive commands preview without mutation and require explicit confirmation", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await invoke(generateCommand, bundle, ["skill", "alpha", "temporary"]);
    const skillPath = join(bundle, "agents", "alpha", "skills", "temporary", "SKILL.md");

    const dryRun = await invoke(destroyCommand, bundle, ["skill", "alpha", "temporary"], { "dry-run": true });
    assert.match(dryRun.stdout, /dry-run: remove/);
    assert.equal(await exists(skillPath), true);
    await assert.rejects(
      () => invoke(destroyCommand, bundle, ["skill", "alpha", "temporary"]),
      /refusing non-interactive deletion/,
    );
    assert.equal(await exists(skillPath), true);
    await invoke(destroyCommand, bundle, ["skill", "alpha", "temporary"], { yes: true });
    assert.equal(await exists(skillPath), false);

    await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    const agentPath = join(bundle, "agents", "alpha");
    await invoke(destroyCommand, bundle, ["agent", "alpha"], { "dry-run": true });
    assert.equal(await exists(agentPath), true);
    await assert.rejects(
      () => invoke(destroyCommand, bundle, ["agent", "alpha"]),
      /refusing non-interactive deletion/,
    );
    await invoke(destroyCommand, bundle, ["agent", "alpha"], { yes: true });
    assert.equal(await exists(agentPath), false);
    assert.doesNotMatch(await readFile(join(bundle, "runtime.env.example"), "utf8"), /PUMBLE_AGENT_ID=alpha/);
    assert.deepEqual(await transactionArtifacts(bundle), []);
  });
});

test("check reports structural and runtime errors without exposing credential values", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const structuralPath = join(bundle, "agents", "alpha", "unexpected.txt");
    await writeText(structuralPath, "not an allowed project surface\n");
    const leaked = "super-secret-value-42";
    const envPath = join(parent, "runtime.env");
    await writeText(envPath, [
      "OMP_BUNDLER_ADAPTER=pumble",
      "PUMBLE_APP_ID=app",
      `PUMBLE_APP_CLIENT_SECRET=${leaked}`,
      "PUMBLE_APP_KEY=app-key",
      "PUMBLE_APP_SIGNING_SECRET=signing-secret",
      "PUMBLE_PUBLIC_BASE_URL=http://localhost:3000",
      "PUMBLE_CORE_SHARED_SECRET=shared-secret",
      "PUMBLE_AGENT_ID=missing-agent",
      "OMP_AUTH_BROKER_URL=not-a-url",
      `OMP_AUTH_BROKER_TOKEN=${leaked}`,
      "",
    ].join("\n"));

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.path === structuralPath));
    assert(report.errors.some((entry) => entry.field === "PUMBLE_AGENT_ID"));
    assert(report.errors.some((entry) => entry.field === "OMP_AUTH_BROKER_URL"));
    assert(report.credentialNames.includes("PUMBLE_APP_CLIENT_SECRET"));
    assert(report.errors.every((entry) => !entry.message.includes(leaked)));

    const checked = await invoke(checkCommand, bundle, [], { "env-file": envPath });
    assert.equal(checked.result, 1);
    assert.match(checked.stderr, /unexpected\.txt/);
    assert.match(checked.stderr, /PUMBLE_AGENT_ID/);
    assert.doesNotMatch(`${checked.stdout}\n${checked.stderr}`, new RegExp(leaked));
  });
});

test("check accepts the default HTTP adapter without Pumble fields", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(parent, "runtime.env");
    await writeText(
      envPath,
      await readFile(join(bundle, "runtime.env.example"), "utf8"),
    );

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  });
});

test("check rejects incomplete explicit adapters without exposing adapter secrets", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const envPath = join(parent, "explicit-incomplete.env");
    const adapterSecret = "explicit-adapter-secret";
    await writeText(envPath, [
      "OMP_BUNDLER_ADAPTER=pumble",
      `OMP_ADAPTERS=[{"adapterId":"external","callbackUrl":"http://127.0.0.1:8765/core/events","sharedSecret":"${adapterSecret}","agentId":"alpha"}]`,
      "",
    ].join("\n"));

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, false);
    for (const field of [
      "PUMBLE_APP_ID",
      "PUMBLE_APP_CLIENT_SECRET",
      "PUMBLE_APP_KEY",
      "PUMBLE_APP_SIGNING_SECRET",
      "PUMBLE_PUBLIC_BASE_URL",
      "PUMBLE_CORE_SHARED_SECRET",
    ]) {
      assert(report.errors.some((entry) => entry.field === field));
    }
    assert.equal(report.errors.some((entry) => entry.field === "PUMBLE_AGENT_ID"), false);
    assert(report.errors.every((entry) => !entry.message.includes(adapterSecret)));

    const checked = await invoke(checkCommand, bundle, [], { "env-file": envPath });
    assert.equal(checked.result, 1);
    assert.doesNotMatch(`${checked.stdout}\n${checked.stderr}`, new RegExp(adapterSecret));
  });
});

test("check accepts complete explicit adapters without PUMBLE_AGENT_ID", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(parent, "explicit-complete.env");
    await writeText(envPath, [
      "OMP_BUNDLER_ADAPTER=pumble",
      "PUMBLE_APP_ID=app",
      "PUMBLE_APP_CLIENT_SECRET=client-secret",
      "PUMBLE_APP_KEY=app-key",
      "PUMBLE_APP_SIGNING_SECRET=signing-secret",
      "PUMBLE_PUBLIC_BASE_URL=http://localhost:3000",
      "PUMBLE_CORE_SHARED_SECRET=shared-secret",
      'OMP_ADAPTERS=[{"adapterId":"external","callbackUrl":"http://127.0.0.1:8765/core/events","sharedSecret":"adapter-secret","agentId":"alpha"}]',
      "",
    ].join("\n"));

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    const checked = await invoke(checkCommand, bundle, [], { "env-file": envPath });
    assert.equal(checked.result, 0);
  });
});

test("check keeps synthesized Pumble registration validation unchanged", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(parent, "synthesized.env");
    await writeText(envPath, runtimeEnv("alpha"));

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);

    await writeText(envPath, runtimeEnv("alpha").replace("PUMBLE_AGENT_ID=alpha\n", ""));
    const missingAgent = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(missingAgent.ok, false);
    assert(missingAgent.errors.some((entry) => entry.field === "PUMBLE_AGENT_ID"));
  });
});

test("check and run reject fixed internal listener overrides in the runtime env file", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(parent, "listener-overrides.env");
    await writeText(envPath, [
      ...runtimeEnv().trim().split("\n"),
      "OMP_HOST=",
      "OMP_PORT=9999",
      "PUMBLE_BRIDGE_HOST=127.0.0.1",
      "PUMBLE_BRIDGE_PORT=not-a-port",
      "",
    ].join("\n"));

    const report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, false);
    for (const name of ["OMP_HOST", "OMP_PORT", "PUMBLE_BRIDGE_HOST", "PUMBLE_BRIDGE_PORT"]) {
      assert(report.errors.some((entry) => entry.field === name));
    }
    assert(report.errors.every((entry) => (
      !entry.message.includes("9999") && !entry.message.includes("127.0.0.1") && !entry.message.includes("not-a-port")
    )));
    assert.equal(report.errors.some((entry) => entry.field === "PUMBLE_BRIDGE_PORT" && entry.message.includes("integer")), false);

    const checked = await invoke(checkCommand, bundle, [], { "env-file": envPath });
    assert.equal(checked.result, 1);
    assert.match(checked.stderr, /OMP_HOST/);
    assert.match(checked.stderr, /OMP_PORT/);
    assert.match(checked.stderr, /PUMBLE_BRIDGE_HOST/);
    assert.match(checked.stderr, /PUMBLE_BRIDGE_PORT/);

    const ran = await invoke(runCommand, bundle, [], { "env-file": envPath, "dry-run": true });
    assert.equal(ran.result, 1);
    assert.match(ran.stderr, /OMP_PORT/);
    assert.doesNotMatch(`${ran.stdout}\n${ran.stderr}`, /docker run/);
  });
});

test("check scans normalized credential fields without flagging placeholders or opaque identifiers", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["leaky"], { agent: "alpha" });
    const leaky = join(parent, "leaky");
    await seedModel(leaky, "alpha");
    const leakyOmp = join(leaky, "agents", "alpha");
    const leakedValues = [
      "json-api-token-literal",
      "json-uppercase-token-literal",
      "yaml-secret-literal",
      "yaml-credential-literal",
      "source-token-literal",
    ];
    await writeText(join(leakyOmp, "settings.json"), JSON.stringify({
      api_token: leakedValues[0],
      API_TOKEN: leakedValues[1],
    }));
    await writeText(join(leakyOmp, "config.yml"), [
      "setupVersion: 1",
      `secret: ${leakedValues[2]}`,
      `credential: ${leakedValues[3]}`,
      "",
    ].join("\n"));
    await writeText(join(leakyOmp, "tools", "literal.ts"), `export default () => ({
  execute: async () => ({ token: "${leakedValues[4]}" }),
});
`);

    const rejected = await invoke(checkCommand, leaky, []);
    assert.equal(rejected.result, 1);
    assert.match(rejected.stderr, /settings\.json.*api_token/);
    assert.match(rejected.stderr, /config\.yml.*secret/);
    assert.match(rejected.stderr, /config\.yml.*credential/);
    assert.match(rejected.stderr, /literal\.ts.*token/);
    for (const value of leakedValues) {
      assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(value));
    }

    await invoke(newCommand, parent, ["safe"], { agent: "alpha" });
    const safe = join(parent, "safe");
    await seedModel(safe, "alpha");
    const safeOmp = join(safe, "agents", "alpha");
    await writeText(join(safeOmp, "settings.json"), JSON.stringify({
      api_token: "${API_TOKEN}",
      token: "$TOKEN",
      secret: "process.env.SECRET",
      credential: "env.CREDENTIAL",
      tokenId: "opaque-token-id",
      maxTokens: 128000,
    }));
    await writeText(join(safeOmp, "config.yml"), [
      "setupVersion: 1",
      "api_token: ${API_TOKEN}",
      "secret:",
      "",
    ].join("\n"));
    await writeText(join(safeOmp, "AGENTS.md"), "# alpha\n\nOrdinary prose may mention token: examples.\n");
    await writeText(join(safeOmp, "tools", "safe.ts"), `const token = process.env.API_TOKEN;
const tokenId = "opaque-token-id";
const note = "token: ordinary prose";
export default () => ({ execute: async () => ({}) });
`);

    const passed = await invoke(checkCommand, safe, []);
    assert.equal(passed.result, 0);
    assert.match(passed.stdout, /Check passed/);
    assert.equal(passed.stderr, "");
  });
});
test("check rejects credential fallback literals without printing values", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["fallback"], { agent: "alpha" });
    const fallback = join(parent, "fallback");
    await seedModel(fallback, "alpha");
    const fallbackOmp = join(fallback, "agents", "alpha");
    const fallbackValues = [
      "fallback-default",
      "fallback-alternate",
      "fallback-error",
      "source-fallback",
      "source-mixed",
    ];
    await writeText(join(fallbackOmp, "settings.json"), JSON.stringify({
      api_token: "${API_TOKEN:-" + fallbackValues[0] + "}",
      token: "${TOKEN:+" + fallbackValues[1] + "}",
      secret: "${SECRET",
    }));
    await writeText(join(fallbackOmp, "config.yml"), [
      "setupVersion: 1",
      `secret: \${SECRET:?${fallbackValues[2]}}`,
      "",
    ].join("\n"));
    await writeText(join(fallbackOmp, "tools", "fallback.ts"), `const token = "\${TOKEN:-${fallbackValues[3]}}";
const token = "prefix-\${TOKEN}-${fallbackValues[4]}";
export default () => ({ execute: async () => ({}) });
`);

    const rejected = await invoke(checkCommand, fallback, []);
    assert.equal(rejected.result, 1);
    assert.match(rejected.stderr, /settings\.json.*api_token/);
    assert.match(rejected.stderr, /settings\.json.*token/);
    assert.match(rejected.stderr, /settings\.json.*secret/);
    assert.match(rejected.stderr, /config\.yml.*secret/);
    assert.match(rejected.stderr, /fallback\.ts.*token/);
    for (const value of fallbackValues) {
      assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(value));
    }
    assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /\$\{SECRET/);

    await invoke(newCommand, parent, ["exact"], { agent: "alpha" });
    const exact = join(parent, "exact");
    await seedModel(exact, "alpha");
    await writeText(join(exact, "agents", "alpha", "settings.json"), JSON.stringify({
      api_token: "${API_TOKEN}",
      token: "$TOKEN",
      secret: "process.env.SECRET",
      credential: "env.CREDENTIAL",
    }));
    const passed = await invoke(checkCommand, exact, []);
    assert.equal(passed.result, 0);
    assert.match(passed.stdout, /Check passed/);
    assert.equal(passed.stderr, "");
  });
});
test("packaged assets and Docker contexts use allowlists and reject symlinks", async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source, { recursive: true });
    await createCanonicalAssetSource(source);
    await stagePackagedAssets(source, destination);

    assert.equal(await exists(join(destination, "Dockerfile")), true);
    assert.equal(await exists(join(destination, "dist")), false);
    assert.equal(await exists(join(destination, "node_modules")), false);
    assert.equal(await exists(join(destination, "packages", "core", "test")), false);

    await symlink(join(source, "Dockerfile"), join(source, "build", "linked-dockerfile"));
    await assert.rejects(
      () => stagePackagedAssets(source, destination),
      /refusing to stage symlink/,
    );
    await rm(join(source, "build", "linked-dockerfile"));

    const agentSource = join(root, "agent-source", "alpha");
    await writeText(join(agentSource, "AGENTS.md"), "# alpha\n");
    await writeText(join(agentSource, "tools", "lookup.ts"), "export default () => ({ execute: async () => ({}) });\n");
    const agent = { id: "alpha", path: agentSource };
    const contextPath = await stageDockerContext([agent], source);
    try {
      assert.equal(await exists(join(contextPath, "Dockerfile")), true);
      assert.equal(await exists(join(contextPath, "dist")), false);
      assert.equal(await exists(join(contextPath, "agents", "alpha", ".omp", "AGENTS.md")), true);
      assert.equal(await exists(join(contextPath, "agents", "alpha", ".omp", "tools", "lookup.ts")), true);
      assert.equal(await exists(join(contextPath, "agents", "alpha", "AGENTS.md")), false);
    } finally {
      await removeDockerContext(contextPath);
    }

    await symlink(join(source, "Dockerfile"), join(agentSource, "linked-file"));
    await assert.rejects(
      () => stageDockerContext([agent], source),
      /refusing to stage symlink/,
    );
  });
});

test("Docker argument precedence is explicit and run dry-run never executes Docker", async () => {
  await withTempDirectory(async (parent) => {
    const project = {
      rootDir: join(parent, "demo"),
      config: {
        version: 1,
        agentsDir: "./agents",
        image: { tag: "configured:tag" },
        run: { dataVolume: "configured-data", corePort: 9100, adapterPort: 9200 },
      },
    };
    assert.equal(resolveBuildTag({ project }, undefined), "configured:tag");
    assert.equal(resolveBuildTag({ project }, "override:tag"), "override:tag");
    const settings = resolveRunSettings({ project });
    assert.deepEqual(settings, {
      image: "configured:tag",
      dataVolume: "configured-data",
      corePort: 9100,
      adapterPort: 9200,
      containerName: "configured-data-service",
    });
    assert.equal(resolveRunSettings({ project }, "override:tag").image, "override:tag");
    assert.equal(buildPreviewCommand("override:tag", "/tmp/docker-context"), "docker build -t override:tag /tmp/docker-context");
    assert.equal(
      runPreviewCommand(settings, "/tmp/runtime.env"),
      "docker run --rm --name configured-data-service -p 9100:8787 -p 9200:8765 -v configured-data:/data --env-file /tmp/runtime.env configured:tag",
    );

    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, runtimeEnv());
    const dryRun = await invoke(
      runCommand,
      bundle,
      [],
      { "env-file": envPath, image: "override:tag", "dry-run": true },
    );
    assert.equal(dryRun.result, 0);
    assert.equal(dryRun.stderr, "");
    assert.equal(
      dryRun.stdout.trim(),
      `docker run --rm --name bundle-data-service -p 8787:8787 -p 8765:8765 -v bundle-data:/data --env-file ${envPath} override:tag`,
    );
  });
});
test("service lifecycle uses one deterministic detached Docker container", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    await writeText(join(bundle, "runtime.env"), runtimeEnv());

    const preview = await invoke(serviceCommand, bundle, ["start"], { "dry-run": true });
    assert.equal(preview.result, 0, preview.stderr);
    assert.match(preview.stdout, /^docker run --rm -d --name bundle-data-service /);

    const capturePath = join(parent, "docker-calls.jsonl");
    await writeFile(join(parent, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args) + "\\n");
if (process.env.DOCKER_MISSING === "1" && ["inspect", "stop", "restart"].includes(args[0])) {
  console.error("Error: No such object: " + args.at(-1));
  process.exit(1);
}
if (args[0] === "inspect") console.log("running");
if (args[0] === "run") console.log("container-id");
`, { mode: 0o755 });

    const previousPath = process.env.PATH;
    const previousMissing = process.env.DOCKER_MISSING;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const started = await invoke(serviceCommand, bundle, ["start"]);
      assert.equal(started.result, 0, started.stderr);
      assert.match(started.stdout, /Started service bundle-data-service/);
      const status = await invoke(serviceCommand, bundle, ["status"]);
      assert.equal(status.result, 0, status.stderr);
      assert.equal(status.stdout, "Service bundle-data-service: running\n");
      const stopped = await invoke(serviceCommand, bundle, ["stop"]);
      assert.equal(stopped.result, 0, stopped.stderr);
      assert.equal(stopped.stdout, "Service bundle-data-service: stopped\n");
      const restarted = await invoke(serviceCommand, bundle, ["restart"]);
      assert.equal(restarted.result, 0, restarted.stderr);
      assert.equal(restarted.stdout, "Service bundle-data-service: restarted\n");

      process.env.DOCKER_MISSING = "1";
      const missingStatus = await invoke(serviceCommand, bundle, ["status"]);
      assert.equal(missingStatus.result, 1);
      assert.equal(missingStatus.stdout, "Service bundle-data-service: stopped\n");
      assert.equal((await invoke(serviceCommand, bundle, ["stop"])).result, 0);
      const missingRestart = await invoke(serviceCommand, bundle, ["restart"]);
      assert.equal(missingRestart.result, 1);
      assert.match(missingRestart.stderr, /service start/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMissing === undefined) delete process.env.DOCKER_MISSING;
      else process.env.DOCKER_MISSING = previousMissing;
    }

    const calls = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].slice(0, 5), ["run", "--rm", "-d", "--name", "bundle-data-service"]);
    assert.deepEqual(calls[1], ["inspect", "--type", "container", "--format", "{{.State.Status}}", "bundle-data-service"]);
    assert.deepEqual(calls[2], ["stop", "bundle-data-service"]);
    assert.deepEqual(calls[3], ["restart", "bundle-data-service"]);
  });
});


test("run --agents validates bindings against the same alternate collection as build", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const alternate = join(parent, "alternate-agents");
    await writeText(join(alternate, "beta", "AGENTS.md"), "# beta\n");
    await writeText(join(alternate, "beta", "config.yml"), "setupVersion: 1\n");
    for (const surface of ["agents", "commands", "extensions", "skills", "tools"]) {
      await mkdir(join(alternate, "beta", surface), { recursive: true });
    }
    await rm(join(bundle, "models", "alpha.yml"));
    await seedModel(bundle, "beta");

    const betaEnv = join(bundle, "beta.env");
    await writeText(betaEnv, runtimeEnv("beta"));

    const buildReport = await validateBundle({ cwd: bundle, agentsDirOverride: alternate });
    assert.equal(buildReport.ok, true);
    assert.deepEqual(buildReport.agents.map((agent) => agent.id), ["beta"]);

    const rejected = await invoke(runCommand, bundle, [], { "env-file": betaEnv, "dry-run": true });
    assert.equal(rejected.result, 1);
    assert.match(rejected.stderr, /references 'beta', which is not a direct child of the effective agent collection/);

    const passed = await invoke(runCommand, bundle, [], { "env-file": betaEnv, agents: alternate, "dry-run": true });
    assert.equal(passed.result, 0);
    assert.equal(passed.stderr, "");
    assert.equal(
      passed.stdout.trim(),
      `docker run --rm --name bundle-data-service -p 8787:8787 -p 8765:8765 -v bundle-data:/data --env-file ${betaEnv} bundle:local`,
    );
    await seedModel(bundle, "alpha");
    await rm(join(bundle, "models", "beta.yml"));

    const alphaEnv = join(bundle, "alpha.env");
    await writeText(alphaEnv, runtimeEnv("alpha"));
    const defaulted = await invoke(runCommand, bundle, [], { "env-file": alphaEnv, "dry-run": true });
    assert.equal(defaulted.result, 0);
    assert.equal(defaulted.stderr, "");

    const missing = await invoke(runCommand, bundle, [], { "env-file": alphaEnv, agents: join(parent, "no-such-agents"), "dry-run": true });
    assert.equal(missing.result, 1);
    assert.match(missing.stderr, /agent collection is missing/);

    const filePath = join(parent, "not-a-directory");
    await writeText(filePath, "plain file\n");
    const fileOverride = await invoke(runCommand, bundle, [], { "env-file": alphaEnv, agents: filePath, "dry-run": true });
    assert.equal(fileOverride.result, 1);
    assert.match(fileOverride.stderr, /agent collection must be a directory/);

    const invalid = join(parent, "invalid-agents");
    await writeText(join(invalid, "stray.txt"), "not an agent\n");
    const invalidOverride = await invoke(runCommand, bundle, [], { "env-file": alphaEnv, agents: invalid, "dry-run": true });
    assert.equal(invalidOverride.result, 1);
    assert.match(invalidOverride.stderr, /every direct child of agentsDir must be an agent directory/);
  });
});

test("check requires distinct run host ports and keeps valid defaults and customs", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, runtimeEnv());
    const configPath = join(bundle, "omp-bundler.yml");

    const generatedConfig = (corePort, adapterPort) => [
      "version: 1",
      "agentsDir: ./agents",
      "run:",
      "  dataVolume: bundle-data",
      `  corePort: ${corePort}`,
      `  adapterPort: ${adapterPort}`,
      "",
    ].join("\n");

    let report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);

    await writeText(configPath, generatedConfig(9100, 9200));
    report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    const dryRun = await invoke(runCommand, bundle, [], { "env-file": envPath, "dry-run": true });
    assert.equal(dryRun.result, 0);
    assert.match(dryRun.stdout, /-p 9100:8787 -p 9200:8765/);

    await writeText(configPath, generatedConfig(9100, 9100));
    report = await validateBundle({ cwd: bundle, envFile: envPath });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.field === "run.corePort/run.adapterPort"));
    const checked = await invoke(checkCommand, bundle, [], { "env-file": envPath });
    assert.equal(checked.result, 1);
    assert.match(checked.stderr, /run\.corePort\/run\.adapterPort/);
    const ran = await invoke(runCommand, bundle, [], { "env-file": envPath, "dry-run": true });
    assert.equal(ran.result, 1);
    assert.doesNotMatch(`${ran.stdout}\n${ran.stderr}`, /docker run/);
  });
});
test("run maps SIGTERM to Docker SIGINT, keeps SIGINT unchanged, and waits for close", async () => {
  await withTempDirectory(async (parent) => {
    const startedPath = join(parent, "docker-started");
    const signalPath = join(parent, "docker-signal");
    const dockerPath = join(parent, "docker");
    await writeFile(
      dockerPath,
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const startedPath = ${JSON.stringify(startedPath)};
const signalPath = ${JSON.stringify(signalPath)};
writeFileSync(startedPath, "started");
const shutdown = (signal) => {
  writeFileSync(signalPath, signal);
  setTimeout(() => process.exit(0), 100);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
setTimeout(() => process.exit(2), 1000);
`,
      { mode: 0o755 },
    );

    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, runtimeEnv());

    const previousPath = process.env.PATH;
    const baselineSigint = process.listenerCount("SIGINT");
    const baselineSigterm = process.listenerCount("SIGTERM");
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    let runPromise;
    let settled = false;
    try {
      runPromise = invoke(runCommand, bundle, [], { "env-file": envPath }).then((value) => {
        settled = true;
        return value;
      });
      await waitForFile(startedPath);
      process.emit("SIGTERM");
      await waitForFile(signalPath);
      assert.equal(await readFile(signalPath, "utf8"), "SIGINT");
      await delay(20);
      assert.equal(settled, false);
      const termResult = await runPromise;
      assert.equal(termResult.result, 0);
      assert.equal(process.listenerCount("SIGINT"), baselineSigint);
      assert.equal(process.listenerCount("SIGTERM"), baselineSigterm);

      await rm(startedPath, { force: true });
      await rm(signalPath, { force: true });
      settled = false;
      runPromise = invoke(runCommand, bundle, [], { "env-file": envPath }).then((value) => {
        settled = true;
        return value;
      });
      await waitForFile(startedPath);
      process.emit("SIGINT");
      await waitForFile(signalPath);
      assert.equal(await readFile(signalPath, "utf8"), "SIGINT");
      await delay(20);
      assert.equal(settled, false);
      const intResult = await runPromise;
      assert.equal(intResult.result, 0);
      assert.equal(process.listenerCount("SIGINT"), baselineSigint);
      assert.equal(process.listenerCount("SIGTERM"), baselineSigterm);
    } finally {
      if (runPromise !== undefined && !settled) {
        process.emit("SIGTERM");
        await runPromise.catch(() => {});
      }
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
test("source commands reject a direct legacy .omp agent layout", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"]);
    const bundle = join(parent, "bundle");
    await createLegacyAgent(bundle, "alpha");
    const envPath = join(bundle, "runtime.env");
    await writeText(envPath, runtimeEnv());

    const checked = await invoke(checkCommand, bundle, []);
    assert.equal(checked.result, 1);
    assert.match(checked.stderr, /must not be a nested \.omp directory/);

    await assert.rejects(
      () => invoke(generateCommand, bundle, ["skill", "alpha", "preview"]),
      /nested \.omp directory/,
    );
    await assert.rejects(
      () => invoke(setModelCommand, bundle, ["alpha"], { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "acme/model-v1" }),
      /nested \.omp directory/,
    );

    const built = await invoke(buildCommand, bundle, []);
    assert.equal(built.result, 1);
    assert.match(built.stderr, /must not be a nested \.omp directory/);

    const ran = await invoke(runCommand, bundle, [], { "env-file": envPath, "dry-run": true });
    assert.equal(ran.result, 1);
    assert.match(ran.stderr, /must not be a nested \.omp directory/);
    assert.doesNotMatch(`${ran.stdout}\n${ran.stderr}`, /docker run/);

    await assert.rejects(
      () => discoverAgents(join(bundle, "agents")),
      /nested \.omp directory/,
    );
  });
});

test("migrate visible-layout dry-run previews without moving legacy .omp source", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"]);
    const bundle = join(parent, "bundle");
    const { agentRoot, omp } = await createLegacyAgent(bundle, "alpha");

    const dryRun = await invoke(migrateCommand, bundle, ["visible-layout"], { "dry-run": true });
    assert.equal(dryRun.result, 0);
    assert.match(dryRun.stdout, /dry-run: move .*\.omp[\\/]AGENTS\.md -> .*agents[\\/]alpha[\\/]AGENTS\.md/);
    assert.match(dryRun.stdout, /dry-run: move .*\.omp[\\/]tools -> .*agents[\\/]alpha[\\/]tools/);
    assert.match(dryRun.stdout, /dry-run: remove .*agents[\\/]alpha[\\/]\.omp$/m);
    assert.equal(await exists(join(omp, "AGENTS.md")), true);
    assert.equal(await exists(join(omp, "tools", "lookup.ts")), true);
    assert.equal(await exists(join(agentRoot, "AGENTS.md")), false);
    assert.equal(await exists(join(agentRoot, ".omp")), true);
  });
});

test("migrate visible-layout is confirmation-gated, promotes legacy children, and is idempotent", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const { agentRoot, omp } = await createLegacyAgent(bundle, "beta");
    await writeText(join(agentRoot, "settings.json"), JSON.stringify({ note: "visible state" }));
    await seedModel(bundle, "beta");

    // Non-interactive runs without --yes refuse before any mutation.
    await assert.rejects(
      () => invoke(migrateCommand, bundle, ["visible-layout"]),
      /refusing non-interactive deletion; pass --yes to confirm/,
    );
    assert.equal(await exists(join(omp, "AGENTS.md")), true);
    assert.equal(await exists(join(agentRoot, ".omp")), true);
    assert.equal(await exists(join(agentRoot, "AGENTS.md")), false);

    const migrated = await invoke(migrateCommand, bundle, ["visible-layout"], { yes: true });
    assert.equal(migrated.result, 0, migrated.stderr);
    assert.equal(await readFile(join(agentRoot, "AGENTS.md"), "utf8"), "# beta\n\nLegacy hidden-layout instructions.\n");
    assert.equal(await exists(join(agentRoot, "config.yml")), true);
    assert.equal(await exists(join(agentRoot, "tools", "lookup.ts")), true);
    assert.equal(await exists(join(agentRoot, "skills", "knowledge-base", "SKILL.md")), true);
    assert.equal(await exists(join(agentRoot, ".omp")), false);
    assert.deepEqual(JSON.parse(await readFile(join(agentRoot, "settings.json"), "utf8")), { note: "visible state" });
    // The already-visible alpha agent is left untouched.
    assert.equal(await exists(join(bundle, "agents", "alpha", "AGENTS.md")), true);
    assert.equal(await exists(join(bundle, "agents", "alpha", ".omp")), false);
    assert.deepEqual(await transactionArtifacts(bundle), []);

    // The migrated bundle is a valid visible-layout bundle.
    const checked = await invoke(checkCommand, bundle, []);
    assert.equal(checked.result, 0, checked.stderr);
    assert.match(checked.stdout, /Agents: alpha, beta/);

    // A second run has nothing left to migrate.
    const repeated = await invoke(migrateCommand, bundle, ["visible-layout"], { yes: true });
    assert.equal(repeated.result, 0);
    assert.match(repeated.stdout, /nothing to migrate/);
    assert.equal(await exists(join(agentRoot, "AGENTS.md")), true);
    assert.equal(await exists(join(agentRoot, ".omp")), false);
  });
});

test("migrate visible-layout refuses to overwrite existing agent surface paths", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"]);
    const bundle = join(parent, "bundle");
    const { agentRoot, omp } = await createLegacyAgent(bundle, "alpha");
    await writeText(join(agentRoot, "AGENTS.md"), "visible instructions\n");

    await assert.rejects(
      () => invoke(migrateCommand, bundle, ["visible-layout"], { yes: true }),
      /refusing to overwrite existing agent surface path/,
    );
    assert.equal(await readFile(join(agentRoot, "AGENTS.md"), "utf8"), "visible instructions\n");
    assert.equal(await exists(join(omp, "AGENTS.md")), true);
    assert.equal(await exists(join(omp, "tools", "lookup.ts")), true);
  });
});

test("migrate visible-layout rejects symlinked legacy .omp source", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"]);
    const bundle = join(parent, "bundle");
    const { agentRoot, omp } = await createLegacyAgent(bundle, "alpha");

    // A symlink nested inside the legacy .omp tree is rejected before any move.
    const outside = join(parent, "outside-tool.ts");
    await writeText(outside, "export {};\n");
    await symlink(outside, join(omp, "tools", "linked.ts"));
    await assert.rejects(
      () => invoke(migrateCommand, bundle, ["visible-layout"], { yes: true }),
      /legacy \.omp path contains a symlink/,
    );
    assert.equal(await exists(join(agentRoot, ".omp")), true);
    assert.equal(await exists(join(agentRoot, "AGENTS.md")), false);
    await rm(join(omp, "tools", "linked.ts"));

    // A legacy .omp that is itself a symlink is rejected too.
    await rm(omp, { recursive: true });
    await mkdir(join(parent, "outside-omp"));
    await symlink(join(parent, "outside-omp"), omp);
    await assert.rejects(
      () => invoke(migrateCommand, bundle, ["visible-layout"], { yes: true }),
      /legacy \.omp must not be a symlink/,
    );
    assert.equal(await exists(join(agentRoot, ".omp")), true);
    assert.deepEqual(await readdir(join(parent, "outside-omp")), []);
  });
});

test("build stages visible agent roots into .omp destination wrappers", async () => {
  // build stages the packaged runtime from packages/cli/assets, which is
  // gitignored and produced by prepack; materialize it from the repository
  // root the same way prepack does, and restore the original state after.
  const assetsPath = join(REPO_ROOT, "packages", "cli", "assets");
  const assetsPreExisted = await exists(assetsPath);
  if (!assetsPreExisted) await stagePackagedAssets(REPO_ROOT, assetsPath);
  try {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    await invoke(generateCommand, bundle, ["tool", "alpha", "lookup-record"]);
    const bundleBeforeBuild = await snapshotTree(bundle);

    const capturePath = join(parent, "docker-capture.json");
    const dockerPath = join(parent, "docker");
    await writeFile(
      dockerPath,
      `#!${process.execPath}
const { readdirSync, statSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const contextPath = process.argv[process.argv.length - 1];
const files = [];
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path.slice(contextPath.length + 1));
  }
};
walk(contextPath);
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2),
  files,
  models: null,
  template: readFileSync(join(contextPath, "template", "models.yml.tmpl"), "utf8"),
  config: readFileSync(join(contextPath, "agents", "alpha", ".omp", "config.yml"), "utf8"),
}));
`,
      { mode: 0o755 },
    );

    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const built = await invoke(buildCommand, bundle, []);
      assert.equal(built.result, 0, built.stderr);
      assert.match(built.stdout, /Built image: bundle:local/);
      assert.match(built.stdout, /Included agents: alpha/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.deepEqual(captured.args.slice(0, 2), ["build", "-t"]);
    assert(captured.files.includes(join("agents", "alpha", ".omp", "AGENTS.md")));
    assert(captured.files.includes(join("agents", "alpha", ".omp", "config.yml")));
    assert(captured.files.includes(join("agents", "alpha", ".omp", "tools", "lookup-record.ts")));
    assert.equal(captured.files.includes(join("agents", "alpha", "AGENTS.md")), false);
    assert(captured.files.includes("Dockerfile"));
    assert.equal(parseYaml(captured.config).modelRoles.default, "omp-bundler-alpha/gpt-test");
    assert.deepEqual(parseYaml(captured.template), {
      providers: {
        "omp-bundler-alpha": {
          baseUrl: "https://api.test.example/v1",
          api: "openai-responses",
          models: [{ id: "gpt-test", name: "gpt-test" }],
          auth: "none",
        },
      },
    });
    assert.equal((await readFile(join(assetsPath, "template", "models.yml.tmpl"), "utf8")).trim(), "providers: {}");
    assert.equal(captured.files.some((path) => path.startsWith("models/")), false);
    assert.equal(captured.files.some((path) => /alias/i.test(path)), false);
    assert.deepEqual(await snapshotTree(bundle), bundleBeforeBuild);
  });
  } finally {
    if (!assetsPreExisted) await rm(assetsPath, { recursive: true, force: true });
  }
});

test("parent command groups print their available subcommands", async () => {
  for (const [command, pattern] of [
    [generateCommand, /generate agent <agent-id>/],
    [destroyCommand, /destroy agent <agent-id>/],
    [agentCommand, /agent rename <old-agent-id> <new-agent-id>/],
    [migrateCommand, /migrate visible-layout/],
    [serviceCommand, /service start/],
  ]) {
    const help = await invoke(command, process.cwd(), []);
    assert.equal(help.result, 0);
    assert.match(help.stdout, pattern);
    assert.equal(help.stderr, "");
  }
});

test("tui resolves current bundle, directory, agent id, and endpoint selectors", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const configPath = join(bundle, "omp-bundler.yml");
    await writeText(configPath, (await readFile(configPath, "utf8")).replace("adapterPort: 8765", "adapterPort: 9999"));
    await writeText(join(bundle, "runtime.env"), "OMP_HTTP_API_TOKEN='bundle-token'\n");

    assert.deepEqual(await resolveTuiTarget(commandArgs([], {}), bundle), {
      endpoint: "http://localhost:9999/v1/agents/alpha",
      token: "bundle-token",
    });
    assert.deepEqual(await resolveTuiTarget(commandArgs([], { dir: "bundle" }), parent), {
      endpoint: "http://localhost:9999/v1/agents/alpha",
      token: "bundle-token",
    });

    await invoke(generateCommand, bundle, ["agent", "beta"]);
    await assert.rejects(
      () => resolveTuiTarget(commandArgs([], {}), bundle),
      /multiple agents.*select one with --id/,
    );
    assert.deepEqual(await resolveTuiTarget(commandArgs([], { id: "beta" }), bundle), {
      endpoint: "http://localhost:9999/v1/agents/beta",
      token: "bundle-token",
    });

    const endpoint = "https://agents.example.test/v1/agents/remote";
    assert.deepEqual(await resolveTuiTarget(commandArgs([], { endpoint }), bundle), { endpoint });
    await assert.rejects(
      () => resolveTuiTarget(commandArgs([], { endpoint, id: "alpha" }), bundle),
      /--endpoint cannot be combined/,
    );
    const help = await invoke(tuiCommand, bundle, [], { help: true });
    assert.equal(help.result, 0);
    assert.match(help.stdout, /--dir <bundle-path>.*--id <agent-id>.*--endpoint <agent-url>/);
  });
});

test("set-model imports an exact OMP model and credential without exposing the token", async () => {
  await withTempDirectory(async (parent) => {
    const stateDir = join(parent, "omp-state");
    await writeText(join(stateDir, "models.yml"), [
      "providers:",
      "  deepseek:",
      "    baseUrl: https://api.deepseek.com",
      "    api: openai-completions",
      "    apiKey: ignored-source-value",
      "    models:",
      "      - id: deepseek-v4-flash",
      "        name: DeepSeek V4 Flash",
      "",
    ].join("\n"));
    const importedSecret = "deepseek-import-secret";
    const omp = join(parent, "omp");
    await writeFile(omp, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [{ provider: "deepseek", id: "deepseek-v4-flash", selector: "deepseek/deepseek-v4-flash" }] }));
} else if (args[0] === "config") {
  console.log(${JSON.stringify(stateDir)});
} else if (args[0] === "token") {
  console.log(${JSON.stringify(importedSecret)});
} else {
  process.exit(2);
}
`, { mode: 0o755 });

    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await writeText(join(bundle, "agents", "alpha", "config.yml"), "setupVersion: 1\nmodelRoles:\n  default: legacy/provider\n");
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    try {
      const imported = await invoke(setModelCommand, bundle, [], { model: "deepseek/deepseek-v4-flash" });
      assert.equal(imported.result, 0);
      assert.match(imported.stdout, /imported deepseek\/deepseek-v4-flash from OMP/);
      assert.doesNotMatch(`${imported.stdout}\n${imported.stderr}`, new RegExp(importedSecret));
      assert.deepEqual(parseYaml(await readFile(join(bundle, "models", "alpha.yml"), "utf8")), {
        version: 1,
        baseUrl: "https://api.deepseek.com",
        dialect: "openai-completions",
        model: "deepseek-v4-flash",
        apiKey: "${OMP_MODEL_ALPHA_API_KEY}",
      });
      const example = await readFile(join(bundle, "runtime.env.example"), "utf8");
      assert.match(example, /OMP_MODEL_ALPHA_API_KEY=/);
      assert.doesNotMatch(example, new RegExp(importedSecret));
      const runtimePath = join(bundle, "runtime.env");
      const runtime = await readFile(runtimePath, "utf8");
      assert.match(runtime, new RegExp(`OMP_MODEL_ALPHA_API_KEY=${importedSecret}`));
      assert.equal(runtime.split("OMP_MODEL_ALPHA_API_KEY=").length - 1, 1);
      assert.equal((await lstat(runtimePath)).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(join(bundle, "agents", "alpha", "config.yml"), "utf8"), /modelRoles/);

      const explicit = await invoke(setModelCommand, bundle, [], {
        from: "omp",
        model: "deepseek/deepseek-v4-flash",
      });
      assert.equal(explicit.result, 0);
      assert.doesNotMatch(`${explicit.stdout}\n${explicit.stderr}`, new RegExp(importedSecret));
      assert.equal((await readFile(runtimePath, "utf8")).split("OMP_MODEL_ALPHA_API_KEY=").length - 1, 1);
      const checked = await invoke(checkCommand, bundle, []);
      assert.equal(checked.result, 0, `${checked.stdout}\n${checked.stderr}`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("set-model help and agent inference cover zero, single, and multiple agents", async () => {
  const help = await invoke(setModelCommand, process.cwd(), [], { help: true });
  assert.equal(help.result, 0);
  assert.match(help.stdout, /set-model \[agent-id\]/);
  assert.match(help.stdout, /--base-url <value>/);
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["empty"]);
    await assert.rejects(() => invoke(setModelCommand, join(parent, "empty"), [], {
      "base-url": "https://api.test/v1", dialect: "openai-responses", model: "test",
    }), /no agents found/);
    await invoke(newCommand, parent, ["one"], { agent: "alpha" });
    const one = join(parent, "one");
    await invoke(setModelCommand, one, [], {
      "base-url": "https://api.test/v1", dialect: "openai-responses", model: "test",
    });
    assert.equal(await exists(join(one, "models", "alpha.yml")), true);
    await mkdir(join(one, "agents", "beta"));
    await assert.rejects(() => invoke(setModelCommand, one, [], {
      "base-url": "https://api.test/v1", dialect: "openai-responses", model: "test",
    }), /multiple agents found \(alpha, beta\)/);
  });
  for (const field of ["base-url", "dialect", "model", "api-key"]) assert.match(help.stdout, new RegExp(`--${field} <value>`));
});

test("set-model template, editor, wizard, direct flags, and legacy migration are transactional", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const template = await invoke(setModelCommand, bundle, ["alpha"], { "print-template": true });
    assert.equal(template.result, 0);
    assert.equal(await exists(join(bundle, "models", "alpha.yml")), false);
    assert.match(template.stdout, /templates for baseUrl, model, and apiKey/);
    const editedYaml = "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: edited\napiKey: \"\"\n# edited\n";
    const capturedTemplate = join(parent, "editor-template.yml");
    const editor = await writeEditorScript(parent, "editor", `const fs = require("node:fs"); const target = process.argv[2]; fs.writeFileSync(${JSON.stringify(capturedTemplate)}, fs.readFileSync(target)); fs.writeFileSync(target, ${JSON.stringify(editedYaml)});`);
    await withEditor(editor, () => invoke(setModelCommand, bundle, ["alpha"]));
    assert.equal(await readFile(capturedTemplate, "utf8"), template.stdout);
    assert.equal(await readFile(join(bundle, "models", "alpha.yml"), "utf8"), editedYaml);
    const direct = join(parent, "direct");
    const wizard = join(parent, "wizard");
    await invoke(newCommand, parent, ["direct"], { agent: "alpha" });
    await invoke(newCommand, parent, ["wizard"], { agent: "alpha" });
    const flags = { "base-url": "https://api.test/v1", dialect: "openai-responses", model: "same-model", "api-key": "secret" };
    await invoke(setModelCommand, direct, ["alpha"], flags);
    const prompted = await invokeWithInput(setModelCommand, wizard, ["alpha"], { wizard: true }, "https://api.test/v1\nopenai-responses\nsame-model\nsecret\n");
    assert.equal(prompted.result, 0);
    const directModel = parseYaml(await readFile(join(direct, "models", "alpha.yml"), "utf8"));
    assert.deepEqual(directModel, {
      version: 1,
      baseUrl: "https://api.test/v1",
      dialect: "openai-responses",
      model: "same-model",
      apiKey: "secret",
    });
    assert.deepEqual(parseYaml(await readFile(join(wizard, "models", "alpha.yml"), "utf8")), directModel);
    assert.doesNotMatch(prompted.stdout, /secret/);
    assert.doesNotMatch(prompted.stderr, /secret/);
    await writeText(join(direct, "agents", "alpha", "config.yml"), "# keep\nmodelRoles:\n  default: old\n  other: sibling\n");
    await invoke(setModelCommand, direct, ["alpha"], { model: "changed" });
    assert.equal(await readFile(join(direct, "agents", "alpha", "config.yml"), "utf8"), "# keep\nmodelRoles:\n  other: sibling\n");
    await assert.rejects(() => invoke(setModelCommand, direct, ["alpha"], { wizard: true, model: "nope" }), /mutually exclusive/);
    await assert.rejects(() => invoke(setModelCommand, direct, ["alpha"], { unknown: "nope" }), /unknown option/);
  });
});

test("model validation rejects ownership and YAML boundaries without exposing secrets", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await writeText(join(bundle, "models", "beta.yml"), "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: x\napiKey: secret-value\n");
    let report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.path.endsWith("models/beta.yml")));
    assert(report.errors.every((entry) => !entry.message.includes("secret-value")));
    await rm(join(bundle, "models", "beta.yml"));
    await writeText(join(bundle, "models", "alpha.yml"), "version: nope\napiKey: secret-value\n");
    report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, false);
    assert(report.errors.every((entry) => !entry.message.includes("secret-value")));
    const malformedSecret = "malformed-parser-secret";
    const malformedSource = String.raw`version: 1
baseUrl: https://api.test/v1
dialect: openai-responses
model: valid
apiKey: "${malformedSecret}\q"
`;
    await writeText(join(bundle, "models", "alpha.yml"), malformedSource);
    report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.message.includes("invalid quoted scalar")));
    assert(report.errors.every((entry) => !entry.message.includes(malformedSecret)));
    const checked = await invoke(checkCommand, bundle, []);
    assert.equal(checked.result, 1);
    assert.doesNotMatch(`${checked.stdout}\n${checked.stderr}`, new RegExp(malformedSecret));
    await seedModel(bundle, "alpha", { model: "${MODEL_NAME}", apiKey: "${MODEL_KEY}" });
    report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, true);
  });
});

test("set-model editor preserves unchanged files and failure or cancellation never mutates", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha");
    const modelPath = join(bundle, "models", "alpha.yml");
    const before = await readFile(modelPath, "utf8");
    const unchanged = await writeEditorScript(parent, "unchanged", "");
    const result = await withEditor(unchanged, () => invoke(setModelCommand, bundle, ["alpha"]));
    assert.equal(result.result, 0);
    assert.equal(await readFile(modelPath, "utf8"), before);
    for (const [name, code] of [["failed", 1], ["cancelled", 130]]) {
      const editor = await writeEditorScript(parent, name, `process.exit(${code});`);
      await assert.rejects(() => withEditor(editor, () => invoke(setModelCommand, bundle, ["alpha"])), new RegExp(`exited with code ${code}`));
      assert.equal(await readFile(modelPath, "utf8"), before);
    }
    const configPath = join(bundle, "agents", "alpha", "config.yml");
    const runtimePath = join(bundle, "runtime.env.example");
    await writeText(configPath, "setupVersion: 1\n# preserve\nmodelRoles:\n  default: legacy/provider\n  other: sibling/provider\n");
    const configBefore = await readFile(configPath, "utf8");
    const runtimeBefore = await readFile(runtimePath, "utf8");
    const invalid = await writeEditorScript(parent, "invalid", 'require("node:fs").writeFileSync(process.argv[2], "version: 1\\nbaseUrl: https://api.test/v1\\ndialect: unknown\\nmodel: invalid\\napiKey: \\"\\"\\n");');
    await assert.rejects(() => withEditor(invalid, () => invoke(setModelCommand, bundle, ["alpha"])), /dialect/);
    assert.equal(await readFile(modelPath, "utf8"), before);
    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(runtimePath, "utf8"), runtimeBefore);
    assert.deepEqual(await transactionArtifacts(bundle), []);
    const malformedSecret = "malformed-editor-secret";
    const malformedSource = String.raw`version: 1
baseUrl: https://api.test/v1
dialect: openai-responses
model: valid
apiKey: "${malformedSecret}\q"
`;
    const malformed = await writeEditorScript(parent, "malformed", `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(malformedSource)});`);
    let malformedError;
    try {
      await withEditor(malformed, () => invoke(setModelCommand, bundle, ["alpha"]));
    } catch (error) {
      malformedError = error;
    }
    assert(malformedError instanceof Error);
    assert.match(malformedError.message, /invalid quoted scalar/);
    assert.doesNotMatch(malformedError.message, new RegExp(malformedSecret));
    assert.equal(await readFile(modelPath, "utf8"), before);
    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(runtimePath, "utf8"), runtimeBefore);
    assert.deepEqual(await transactionArtifacts(bundle), []);
  });
});

test("model catalog ownership, placeholders, and model runtime staging remain isolated", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha", { apiKey: "${MODEL_KEY}" });
    const source = await snapshotTree(bundle);
    const env = join(parent, "runtime.env");
    await writeText(env, "MODEL_KEY=\n");
    let report = await validateBundle({ cwd: bundle, envFile: env });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.field === "MODEL_KEY"));
    await writeText(env, "MODEL_KEY=literal-key\n");
    report = await validateBundle({ cwd: bundle, envFile: env });
    assert.equal(report.ok, true);
    assert.deepEqual(await snapshotTree(bundle), source);
  });
});

test("runtime example model blocks are exact, idempotent, and preserve Pumble sections", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const runtime = join(bundle, "runtime.env.example");
    const fresh = "# Bundled adapter. HTTP serves the agent API and built-in terminal chat.\nOMP_BUNDLER_ADAPTER=http\n\n# Optional Bearer token for the public HTTP endpoint. Leave empty only on trusted localhost.\nOMP_HTTP_API_TOKEN=\n";
    assert.equal(await readFile(runtime, "utf8"), fresh);

    const alphaOptions = {
      "base-url": "${ALPHA_URL}",
      dialect: "openai-responses",
      model: "alpha",
      "api-key": "${ALPHA_KEY}",
    };
    await invoke(setModelCommand, bundle, ["alpha"], alphaOptions);
    const alphaHeading = "# Model connection for alpha. Copy this file to runtime.env and fill these values.";
    const alphaExample = `${fresh}\n${alphaHeading}\nALPHA_KEY=\nALPHA_URL=\n`;
    assert.equal(await readFile(runtime, "utf8"), alphaExample);
    await invoke(setModelCommand, bundle, ["alpha"], alphaOptions);
    assert.equal(await readFile(runtime, "utf8"), alphaExample);

    await writeText(runtime, `${alphaExample}\n# User section\nSENTINEL=keep\n`);
    await invoke(generateCommand, bundle, ["agent", "beta"]);
    await invoke(setModelCommand, bundle, ["beta"], {
      "base-url": "https://api.test/v1",
      dialect: "openai-completions",
      model: "beta",
      "api-key": "${BETA_KEY}",
    });
    const betaHeading = "# Model connection for beta. Copy this file to runtime.env and fill these values.";
    const withBeta = await readFile(runtime, "utf8");
    const betaBlock = withBeta.slice(withBeta.indexOf(betaHeading));
    assert.equal(betaBlock, `${betaHeading}\nBETA_KEY=\n`);

    await invoke(setModelCommand, bundle, ["alpha"], {
      "base-url": "https://api.test/v1",
      dialect: "openai-responses",
      model: "alpha",
      "api-key": "",
    });
    const literalAlpha = await readFile(runtime, "utf8");
    assert.doesNotMatch(literalAlpha, /Model connection for alpha|ALPHA_KEY=|ALPHA_URL=/);
    assert.match(literalAlpha, /\n# User section\nSENTINEL=keep\n/);
    assert.equal(literalAlpha.slice(literalAlpha.indexOf(betaHeading)), betaBlock);

    await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    const pumbleOnce = await readFile(runtime, "utf8");
    await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    const pumbleTwice = await readFile(runtime, "utf8");
    assert.equal(pumbleTwice, pumbleOnce);
    const pumbleHeading = "# Pumble adapter. Fill these values from the Pumble app dashboard, then run the bundle.";
    assert.equal(pumbleTwice.split(pumbleHeading).length - 1, 1);
    const pumbleSection = pumbleTwice.slice(pumbleTwice.indexOf(pumbleHeading));
    await invoke(setModelCommand, bundle, ["alpha"], { model: "alpha-2" });
    const afterModelUpdate = await readFile(runtime, "utf8");
    assert.equal(afterModelUpdate.slice(afterModelUpdate.indexOf(pumbleHeading)), pumbleSection);
  });
});

test("set-model editor modes, parser boundaries, and ownership failures stay transactional", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const modelPath = join(bundle, "models", "alpha.yml");
    const runtime = join(bundle, "runtime.env.example");
    const freshRuntime = await readFile(runtime, "utf8");
    const untouched = await writeEditorScript(parent, "untouched", "");
    const fresh = await withEditor(untouched, () => invoke(setModelCommand, bundle, ["alpha"]));
    assert.match(fresh.stdout, /unchanged models[\\/]alpha\.yml/);
    assert.equal(await exists(modelPath), false);
    assert.equal(await readFile(runtime, "utf8"), freshRuntime);
    await seedModel(bundle, "alpha");
    await writeText(join(bundle, "agents", "alpha", "config.yml"), "setupVersion: 1\n# before\nmodelRoles:\n  default: legacy\n  sibling: keep\n");
    await withEditor(untouched, () => invoke(setModelCommand, bundle, ["alpha"]));
    assert.equal(await readFile(join(bundle, "agents", "alpha", "config.yml"), "utf8"), "setupVersion: 1\n# before\nmodelRoles:\n  sibling: keep\n");
    await assert.rejects(() => invoke(setModelCommand, bundle, ["alpha"], { "print-template": true, wizard: true }), /mutually exclusive/);
    await assert.rejects(() => invoke(setModelCommand, bundle, ["alpha"], { "print-template": true, model: "x" }), /mutually exclusive/);
    await assert.rejects(() => invoke(agentCommand, bundle, ["model", "alpha", "x"]), /unknown/);

    const parserEnv = join(parent, "parser.env");
    await writeText(parserEnv, "OMP_BUNDLER_ADAPTER=http\nBASE_URL=https://env.test/v1\nMODEL_ID=env-model\nKEY=env-key\n");
    const accepted = [
      { baseUrl: "http://localhost:8080/v1", dialect: "openai-responses", model: "literal-model", apiKey: "apiKey: literal-secret" },
      { baseUrl: "https://api.test/v1", dialect: "openai-completions", model: "${MODEL_ID}", apiKey: 'apiKey: "${KEY}"' },
      { baseUrl: "${BASE_URL}", dialect: "openai-responses", model: "literal-model", apiKey: undefined },
      { baseUrl: "https://api.test/v1", dialect: "openai-responses", model: "literal-model", apiKey: "apiKey: null" },
      { baseUrl: "https://api.test/v1", dialect: "openai-responses", model: "literal-model", apiKey: 'apiKey: ""' },
    ];
    for (const model of accepted) {
      await writeText(modelPath, [
        "version: 1",
        `baseUrl: ${JSON.stringify(model.baseUrl)}`,
        `dialect: ${model.dialect}`,
        `model: ${JSON.stringify(model.model)}`,
        ...(model.apiKey === undefined ? [] : [model.apiKey]),
        "",
      ].join("\n"));
      const report = await validateBundle({ cwd: bundle, envFile: parserEnv });
      assert.equal(report.ok, true, JSON.stringify(report.errors));
    }

    const rejected = [
      "version: 1\nbaseUrl: ftp://api.test/v1\ndialect: openai-responses\nmodel: valid\napiKey: \"\"\n",
      "version: 1\nbaseUrl: https://api.test/v1\ndialect: unknown\nmodel: valid\napiKey: \"\"\n",
      "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: \"\"\napiKey: \"\"\n",
      "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: \"${MODEL\"\napiKey: literal-secret\n",
    ];
    for (const source of rejected) {
      await writeText(modelPath, source);
      const report = await validateBundle({ cwd: bundle, envFile: parserEnv });
      assert.equal(report.ok, false);
      assert(report.errors.every((entry) => !entry.message.includes("literal-secret")));
    }

    await rm(modelPath);
    let report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.path.endsWith("models/alpha.yml")));

    await seedModel(bundle, "alpha");
    await writeText(join(bundle, "agents", "alpha", "config.yml"), "setupVersion: 1\nmodelRoles:\n  default: legacy/provider\n");
    report = await validateBundle({ cwd: bundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => entry.path.endsWith("agents/alpha/config.yml") && entry.field === "modelRoles.default"));

    const linkedDirBundle = join(parent, "linked-dir");
    await invoke(newCommand, parent, ["linked-dir"], { agent: "alpha" });
    const outsideModels = join(parent, "outside-models");
    await mkdir(outsideModels);
    await writeText(join(outsideModels, "alpha.yml"), "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: linked-dir\napiKey: \"\"\n");
    await symlink(outsideModels, join(linkedDirBundle, "models"));
    report = await validateBundle({ cwd: linkedDirBundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => /symlink/.test(entry.message)));
    const linkedDirRuntime = join(linkedDirBundle, "runtime.env.example");
    const linkedDirRuntimeBefore = await readFile(linkedDirRuntime, "utf8");
    const outsideModelsBefore = await snapshotTree(outsideModels);
    await assert.rejects(() => invoke(setModelCommand, linkedDirBundle, ["alpha"], {
      "base-url": "https://changed.test/v1", dialect: "openai-responses", model: "changed", "api-key": "",
    }), /symlink/);
    assert.deepEqual(await snapshotTree(outsideModels), outsideModelsBefore);
    assert.equal(await readFile(linkedDirRuntime, "utf8"), linkedDirRuntimeBefore);
    assert.deepEqual(await transactionArtifacts(linkedDirBundle), []);

    const linkedFileBundle = join(parent, "linked-file");
    await invoke(newCommand, parent, ["linked-file"], { agent: "alpha" });
    const outsideModel = join(parent, "outside-alpha.yml");
    await writeText(outsideModel, "version: 1\nbaseUrl: https://api.test/v1\ndialect: openai-responses\nmodel: linked\napiKey: \"\"\n");
    await mkdir(join(linkedFileBundle, "models"));
    await symlink(outsideModel, join(linkedFileBundle, "models", "alpha.yml"));
    report = await validateBundle({ cwd: linkedFileBundle });
    assert.equal(report.ok, false);
    assert(report.errors.some((entry) => /symlink/.test(entry.message)));
    const linkedFileRuntime = join(linkedFileBundle, "runtime.env.example");
    const linkedFileRuntimeBefore = await readFile(linkedFileRuntime, "utf8");
    const outsideModelBefore = await readFile(outsideModel, "utf8");
    await assert.rejects(() => invoke(setModelCommand, linkedFileBundle, ["alpha"], {
      "base-url": "https://changed.test/v1", dialect: "openai-responses", model: "changed", "api-key": "",
    }), /symlink/);
    assert.equal(await readFile(outsideModel, "utf8"), outsideModelBefore);
    assert.equal(await readFile(linkedFileRuntime, "utf8"), linkedFileRuntimeBefore);
    assert.deepEqual(await transactionArtifacts(linkedFileBundle), []);
  });
});

test("check and run select runtime env defaults and print exact agent endpoints", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await seedModel(bundle, "alpha", { apiKey: "${MODEL_KEY}" });

    const structural = await invoke(checkCommand, bundle, []);
    assert.equal(structural.result, 0, structural.stderr);
    const missing = await invoke(runCommand, bundle, []);
    assert.equal(missing.result, 1);
    assert.match(missing.stderr, new RegExp(`${join(bundle, "runtime.env").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(missing.stderr, /copy runtime\.env\.example/);

    const defaultEnv = join(bundle, "runtime.env");
    await writeText(defaultEnv, "OMP_BUNDLER_ADAPTER=http\nMODEL_KEY=\n");
    const invalidDefault = await invoke(checkCommand, bundle, []);
    assert.equal(invalidDefault.result, 1);
    assert.match(invalidDefault.stderr, /MODEL_KEY/);

    const explicitEnv = join(parent, "explicit.env");
    await writeText(explicitEnv, "OMP_BUNDLER_ADAPTER=http\nMODEL_KEY=explicit-key\n");
    const explicitCheck = await invoke(checkCommand, bundle, [], { "env-file": explicitEnv });
    assert.equal(explicitCheck.result, 0, explicitCheck.stderr);
    const explicitRun = await invoke(runCommand, bundle, [], { "env-file": explicitEnv, "dry-run": true });
    assert.equal(explicitRun.result, 0, explicitRun.stderr);
    assert.match(explicitRun.stdout, new RegExp(explicitEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await writeText(defaultEnv, "OMP_BUNDLER_ADAPTER=http\nMODEL_KEY=default-key\n");
    const configPath = join(bundle, "omp-bundler.yml");
    const config = await readFile(configPath, "utf8");
    assert.match(config, /adapterPort: 8765/);
    await writeText(configPath, config.replace("adapterPort: 8765", "adapterPort: 9999"));

    const dockerCapture = join(parent, "docker-run.json");
    await writeFile(
      join(parent, "docker"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(dockerCapture)}, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${parent}:${previousPath ?? ""}`;
    let normal;
    try {
      normal = await invoke(runCommand, bundle, []);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(normal.result, 0, normal.stderr);
    const dockerArgs = JSON.parse(await readFile(dockerCapture, "utf8"));
    assert.equal(dockerArgs[0], "run");
    const base = "http://localhost:9999/v1/agents/alpha";
    const endpoint = `Agent endpoint (available once listening; not a readiness check): ${base}`;
    const tui = "TUI: omp-bundler tui";
    assert.deepEqual(
      normal.stdout.split(/\r?\n/).filter((line) => line.startsWith("Agent endpoint") || line.startsWith("TUI:")),
      [endpoint, tui],
    );
  });
});
