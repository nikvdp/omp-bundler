import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { bootCoreServer } from "../src/server.ts";
import type { CoreConfig } from "../src/config.ts";

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
    agentsRootDir: join(root, "agents"),
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

test("boot rejects a durable agent directory without .omp", async () => {
  await withTempDirectory(async (root) => {
    const agentRoot = join(root, "agents");
    await mkdir(join(agentRoot, "stale"), { recursive: true });

    await assert.rejects(
      () => bootCoreServer(config(root, "stale")),
      /adapter "pumble" is bound to agent "stale" but agent \.omp directory .* does not exist/,
    );
  });
});

test("boot accepts a current durable agent with .omp", async () => {
  await withTempDirectory(async (root) => {
    const agentRoot = join(root, "agents");
    await mkdir(join(agentRoot, "current", ".omp"), { recursive: true });

    const server = await bootCoreServer(config(root, "current"));
    try {
      assert.equal(server.listening, true);
    } finally {
      await closeServer(server);
    }
  });
});
