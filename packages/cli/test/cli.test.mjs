import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  agentCommand,
  checkCommand,
  commandArgs,
  destroyCommand,
  generateCommand,
  handlerContext,
  newCommand,
  PACKAGE_ASSET_PATHS,
  removeDockerContext,
  runCommand,
  stageDockerContext,
  stagePackagedAssets,
} from "../src/index.ts";
import {
  buildPreviewCommand,
  resolveBuildTag,
  resolveRunSettings,
  runPreviewCommand,
  validateBundle,
} from "../src/commands/index.ts";

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

async function withTempDirectory(callback) {
  const root = await mkdtemp(join(tmpdir(), "omp-bundler-cli-test-"));
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
  const pumbleServer = join(root, "pumble-server.ts");
  const ambientExtension = join(root, "ambient-ingest-extension.ts");
  await mkdir(binDir, { recursive: true });
  await writeText(join(buildDir, "render-models.ts"), "export {};\n");
  await writeText(join(homeDir, ".omp", "agent", "models.yml.tmpl"), "{}\n");
  await writeText(orphanSweep, "export {};\n");
  await writeText(coreServer, "export {};\n");
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
    assert.equal(await exists(join(parent, "full", "agents", "alpha", ".omp", "AGENTS.md")), true);
    assert.equal(await exists(join(parent, "full", "agents", "alpha", ".omp", "config.yml")), true);
    for (const surface of ["agents", "commands", "extensions", "skills", "tools"]) {
      assert.equal(await exists(join(parent, "full", "agents", "alpha", ".omp", surface)), true);
    }

    await assert.rejects(
      () => invoke(newCommand, parent, ["full"]),
      /bundle destination already exists/,
    );

    await invoke(generateCommand, join(parent, "empty"), ["agent", "later"]);
    assert.equal(await exists(join(parent, "empty", "agents", ".gitkeep")), false);
    assert.equal(await exists(join(parent, "empty", "agents", "later", ".omp", "config.yml")), true);

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
        await exists(join(parent, "full", "agents", "alpha", ".omp", relativePath)),
        true,
      );
    }

    const previewPath = join(parent, "full", "agents", "alpha", ".omp", "tools", "preview.ts");
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

test("Pumble generation is idempotent, rejects conflicting agents, and rename preserves model and files", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const envExample = join(bundle, "runtime.env.example");

    await invoke(generateCommand, bundle, ["adapter", "pumble"], { agent: "alpha" });
    const before = await readFile(envExample, "utf8");
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

    await invoke(agentCommand, bundle, ["model", "alpha", "acme/model-v1"]);
    const configPath = join(bundle, "agents", "alpha", ".omp", "config.yml");
    assert.match(await readFile(configPath, "utf8"), /default: acme\/model-v1/);
    await writeText(join(bundle, "agents", "alpha", "notes.txt"), "alpha custom state\n");
    const ignoredRuntime = join(bundle, "runtime.env");
    await writeText(ignoredRuntime, "PUMBLE_AGENT_ID=alpha\n");

    const renamed = await invoke(agentCommand, bundle, ["rename", "alpha", "renamed"]);
    assert.match(renamed.stdout, /manual reference/);
    assert.equal(await exists(join(bundle, "agents", "alpha")), false);
    assert.equal(await exists(join(bundle, "agents", "renamed", "notes.txt")), true);
    assert.equal(await readFile(join(bundle, "agents", "renamed", "notes.txt"), "utf8"), "alpha custom state\n");
    assert.match(await readFile(join(bundle, "agents", "renamed", ".omp", "config.yml"), "utf8"), /default: acme\/model-v1/);
    assert.match(await readFile(envExample, "utf8"), /PUMBLE_AGENT_ID=renamed/);
    assert.equal(await readFile(ignoredRuntime, "utf8"), "PUMBLE_AGENT_ID=alpha\n");
  });
});

test("destructive commands preview without mutation and require explicit confirmation", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    await invoke(generateCommand, bundle, ["skill", "alpha", "temporary"]);
    const skillPath = join(bundle, "agents", "alpha", ".omp", "skills", "temporary", "SKILL.md");

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
  });
});

test("check reports structural and runtime errors without exposing credential values", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const structuralPath = join(bundle, "agents", "alpha", ".omp", "unexpected.txt");
    await writeText(structuralPath, "not an allowed project surface\n");
    const leaked = "super-secret-value-42";
    const envPath = join(parent, "runtime.env");
    await writeText(envPath, [
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

    const agentOmp = join(root, "agent-source", ".omp");
    await writeText(join(agentOmp, "AGENTS.md"), "# alpha\n");
    const agent = { id: "alpha", path: dirname(agentOmp), ompPath: agentOmp };
    const contextPath = await stageDockerContext([agent], source);
    try {
      assert.equal(await exists(join(contextPath, "Dockerfile")), true);
      assert.equal(await exists(join(contextPath, "dist")), false);
      assert.equal(await exists(join(contextPath, "agents", "alpha", ".omp", "AGENTS.md")), true);
    } finally {
      await removeDockerContext(contextPath);
    }

    await symlink(join(source, "Dockerfile"), join(agentOmp, "linked-file"));
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
    });
    assert.equal(resolveRunSettings({ project }, "override:tag").image, "override:tag");
    assert.equal(buildPreviewCommand("override:tag", "/tmp/docker-context"), "docker build -t override:tag /tmp/docker-context");
    assert.equal(
      runPreviewCommand(settings, "/tmp/runtime.env"),
      "docker run --rm -p 9100:9100 -p 9200:9200 -v configured-data:/data --env-file /tmp/runtime.env configured:tag",
    );

    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
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
      runPreviewCommand({ image: "override:tag", dataVolume: "bundle-data", corePort: 8787, adapterPort: 8765 }, envPath),
    );
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
