import assert from "node:assert/strict";
import { afterEach, jest, test } from "bun:test";

import type {
  OutboundEvent,
  TurnDeltaEvent,
  TurnReplyEvent,
} from "@omp-bundler/contracts/outbound";
import {
  OutboundEmitter,
  type EmitterLogger,
} from "../src/outbound-emitter.ts";
import type { RpcEventFrame } from "../src/rpc-child.ts";

interface EmitterHarness {
  emitter: OutboundEmitter;
  events: OutboundEvent[];
  warnings: string[];
}

afterEach(() => {
  jest.useRealTimers();
});

function createHarness(
  statusFor: (event: OutboundEvent) => number = () => 204,
): EmitterHarness {
  const events: OutboundEvent[] = [];
  const warnings: string[] = [];
  let nextId = 1;
  const logger: EmitterLogger = {
    warn(message) {
      warnings.push(message);
    },
    error() {},
  };
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const event = JSON.parse(String(init?.body)) as OutboundEvent;
    events.push(event);
    return new Response(null, { status: statusFor(event) });
  }) as typeof fetch;

  return {
    emitter: new OutboundEmitter({
      adapterId: "http-test",
      conversationKey: "conversation-1",
      correlationId: "correlation-1",
      resolveAdapterTarget: () => ({
        callbackUrl: "http://adapter.test/core/events",
        sign: () => "test-signature",
      }),
      fetchImpl,
      dbPath: ":memory:",
      progressThresholdMs: Number.MAX_SAFE_INTEGER,
      retryDelaysMs: [],
      requestTimeoutMs: 1_000,
      now: () => 1_000,
      uuid: () => `event-${nextId++}`,
      logger,
    }),
    events,
    warnings,
  };
}

function textDelta(delta: string): RpcEventFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

function deltas(events: OutboundEvent[]): TurnDeltaEvent[] {
  return events.filter(
    (event): event is TurnDeltaEvent => event.type === "turn.delta",
  );
}

function replies(events: OutboundEvent[]): TurnReplyEvent[] {
  return events.filter(
    (event): event is TurnReplyEvent => event.type === "turn.reply",
  );
}

test("streams exact text chunks before the terminal reply", async () => {
  const { emitter, events } = createHarness();
  emitter.ingest({ type: "turn_start" });
  emitter.ingest(textDelta("Hello, "));
  emitter.ingest(textDelta("world"));
  emitter.ingest({ type: "agent_end", messages: [] });
  emitter.ingest(textDelta(" after terminal"));

  await emitter.flush();

  assert.deepEqual(
    events.map((event) => event.type),
    ["turn.started", "turn.delta", "turn.delta", "turn.reply"],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    deltas(events).map((event) => event.text),
    ["Hello, ", "world"],
  );
  assert.equal(replies(events)[0]?.text, "Hello, world");
  emitter.close();
});


test("a failed best-effort delta does not suppress the terminal error", async () => {
  const { emitter, events, warnings } = createHarness((event) =>
    event.type === "turn.delta" ? 503 : 204,
  );
  emitter.ingest({ type: "turn_start" });
  emitter.ingest(textDelta("authoritative"));
  emitter.emitProviderError({
    code: "model_error",
    message: "Agent model request failed",
    retryable: true,
  });

  await emitter.flush();

  assert.deepEqual(
    events.map((event) => event.type),
    ["turn.started", "turn.delta", "turn.error"],
  );
  assert.deepEqual(warnings, ["best-effort outbound delivery non-2xx"]);
  emitter.close();
});
