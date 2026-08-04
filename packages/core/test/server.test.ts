import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { bootCoreServer } from "../src/server.ts";
import {
  loadCoreConfig,
  safeDescribe,
  testConfig,
  type CoreConfig,
} from "../src/config.ts";
import { resolveChildSpawnPlan } from "../src/supervisor.ts";

async function withTempDirectory(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-bundler-core-test-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function config(root: string, agentId: string): CoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    sessionDbPath: ":memory:",
    idempotencyDbPath: ":memory:",
    outboxDbPath: ":memory:",
    childRegistryPath: join(root, "child-registry.json"),
    workspaceDir: join(root, "workspace"),
    ompBinary: "omp",
    ompModel: null,
    ompProfile: null,
    ompArgs: [],
    maxChildren: 1,
    idleTimeoutMs: 1_000,
    engagementWindowMs: 1_000,
    callbackTimeoutMs: 1_000,
    progressThresholdMs: 500,
    retryDelaysMs: [1_000],
    adapters: [
      {
        adapterId: "pumble",
        callbackUrl: "http://127.0.0.1:8765/core/events",
        sharedSecret: "test-secret",
        agentId,
      },
    ],
    agentId,
    agentRootDir: join(root, "agent"),
  };
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

function waitForListening(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (server.listening) {
    resolve();
  } else {
    server.once("listening", resolve);
    server.once("error", reject);
  }
  return promise;
}

test("boot rejects a singular agent root without .omp", async () => {
  await withTempDirectory(async (root) => {
    const agentRoot = join(root, "agent");
    await mkdir(join(agentRoot, "workspace"), { recursive: true });

    await assert.rejects(
      () => bootCoreServer(config(root, "stale")),
      /OMP_AGENT_ROOT .* has no usable \.omp directory/,
    );
  });
});

test("boot accepts a singular agent root with .omp and workspace", async () => {
  await withTempDirectory(async (root) => {
    const agentRoot = join(root, "agent");
    await mkdir(join(agentRoot, ".omp"), { recursive: true });
    await mkdir(join(agentRoot, "workspace"), { recursive: true });

    const server = await bootCoreServer(config(root, "current"));
    await waitForListening(server);
    try {
      assert.equal(server.listening, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("core config requires the singular id and root for bound adapters", () => {
  const secret = "not-for-diagnostics";
  const env = {
    OMP_HOST: "127.0.0.1",
    OMP_PORT: "8787",
    OMP_SESSION_DB_PATH: "/data/core/sessions.sqlite",
    OMP_IDEMPOTENCY_DB_PATH: "/data/core/idempotency.sqlite",
    OMP_OUTBOX_DB_PATH: "/data/core/outbound.sqlite",
    OMP_CHILD_REGISTRY_PATH: "/data/child-registry.json",
    OMP_WORKSPACE_DIR: "/data/workspace",
    OMP_MAX_CHILDREN: "1",
    OMP_IDLE_TIMEOUT_MS: "1000",
    OMP_ENGAGEMENT_WINDOW_MS: "1000",
    OMP_CALLBACK_TIMEOUT_MS: "1000",
    OMP_AGENT_ID: "alpha",
    OMP_AGENT_ROOT: "/data/agent",
    OMP_ADAPTERS: JSON.stringify([
      {
        adapterId: "http-alpha",
        callbackUrl: "http://127.0.0.1:8765/core/events/alpha",
        sharedSecret: secret,
        agentId: "alpha",
      },
    ]),
  };

  const loaded = loadCoreConfig(env);
  assert.equal(loaded.agentId, "alpha");
  assert.equal(loaded.agentRootDir, "/data/agent");
  const described = safeDescribe(loaded);
  assert.equal(described.agentId, "alpha");
  assert.equal(described.agentRootDir, "/data/agent");
  assert.equal(JSON.stringify(described).includes(secret), false);

  assert.throws(
    () => loadCoreConfig({ ...env, OMP_AGENT_ID: "beta" }),
    /does not match OMP_AGENT_ID "beta"/,
  );
  const { OMP_AGENT_ROOT: _, ...withoutSingularRoot } = env;
  assert.throws(
    () =>
      loadCoreConfig({
        ...withoutSingularRoot,
        OMP_AGENTS_ROOT: "/data/agents",
      }),
    /requires OMP_AGENT_ROOT to be set/,
  );
});

test("bound children use the singular workspace and unbound children keep the legacy cwd", () => {
  const coreConfig = testConfig({
    workspaceDir: "/data/workspace",
    agentId: "alpha",
    agentRootDir: "/data/agent",
    ompModel: "provider/model",
    ompArgs: ["--thinking", "high"],
  });

  assert.deepEqual(
    resolveChildSpawnPlan(coreConfig, {
      adapterId: "http-alpha",
      callbackUrl: "http://127.0.0.1/callback",
      sharedSecret: "test-secret",
      agentId: "alpha",
    }),
    {
      cwd: "/data/agent/workspace",
      model: "provider/model",
      args: ["--thinking", "high"],
    },
  );
  assert.deepEqual(
    resolveChildSpawnPlan(coreConfig, {
      adapterId: "legacy",
      callbackUrl: "http://127.0.0.1/callback",
      sharedSecret: "test-secret",
    }),
    {
      cwd: "/data/workspace",
      model: "provider/model",
      args: ["--thinking", "high"],
    },
  );
});
