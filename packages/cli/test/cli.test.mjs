import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  agentCommand,
  checkCommand,
  applyFilePlan,
  createFilePlan,
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
      const componentSurface = join(surfacesBundle, "agents", "alpha", ".omp", surface);
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

test("check rejects incomplete explicit adapters without exposing adapter secrets", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["bundle"], { agent: "alpha" });
    const bundle = join(parent, "bundle");
    const envPath = join(parent, "explicit-incomplete.env");
    const adapterSecret = "explicit-adapter-secret";
    await writeText(envPath, [
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
    const envPath = join(parent, "explicit-complete.env");
    await writeText(envPath, [
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

test("check scans normalized credential fields without flagging placeholders or opaque identifiers", async () => {
  await withTempDirectory(async (parent) => {
    await invoke(newCommand, parent, ["leaky"], { agent: "alpha" });
    const leaky = join(parent, "leaky");
    const leakyOmp = join(leaky, "agents", "alpha", ".omp");
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
    const safeOmp = join(safe, "agents", "alpha", ".omp");
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
      "docker run --rm -p 9100:8787 -p 9200:8765 -v configured-data:/data --env-file /tmp/runtime.env configured:tag",
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
      `docker run --rm -p 8787:8787 -p 8765:8765 -v bundle-data:/data --env-file ${envPath} override:tag`,
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
