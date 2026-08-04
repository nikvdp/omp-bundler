import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import { INBOUND_MESSAGE_MEDIA_TYPE } from "@omp-bundler/contracts/inbound";
import {
  OUTBOUND_EVENT_MEDIA_TYPE,
  OUTBOUND_EVENT_SIGNATURE_HEADER,
  OUTBOUND_EVENT_TYPE_HEADER,
} from "@omp-bundler/contracts/outbound";
import { HttpAgentAdapter, loadHttpAdapterConfig } from "../src/server.ts";

const SHARED_SECRET = "test-shared-secret";
const API_TOKEN = "test-api-token";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function signedEventHeaders(body, type) {
  const signature = crypto.createHmac("sha256", SHARED_SECRET).update(body).digest("hex");
  return {
    "content-type": OUTBOUND_EVENT_MEDIA_TYPE,
    [OUTBOUND_EVENT_SIGNATURE_HEADER]: `sha256=${signature}`,
    [OUTBOUND_EVENT_TYPE_HEADER]: type,
  };
}

function turnEvent(type, sequence, fields = {}) {
  return {
    version: "v1",
    type,
    eventId: `${type}-${sequence}`,
    conversationKey: "local",
    correlationId: "correlation-stream",
    sequence,
    occurredAt: "2026-08-05T00:00:00.000Z",
    ...fields,
  };
}

async function postEvent(baseUrl, event, options = {}) {
  const body = options.body ?? JSON.stringify(event);
  return fetch(`${baseUrl}/core/events/meetings-agent`, {
    method: "POST",
    headers: options.headers ?? signedEventHeaders(body, options.headerType ?? event.type),
    body,
  });
}

function parseSse(raw) {
  assert.equal(raw.includes("\r"), false);
  return raw
    .split("\n\n")
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => {
      const fields = {};
      const data = [];
      for (const line of block.split("\n")) {
        const separator = line.indexOf(":");
        const name = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (name === "data") data.push(value);
        else fields[name] = value;
      }
      assert.equal(typeof fields.event, "string");
      return {
        event: fields.event,
        id: fields.id,
        data: JSON.parse(data.join("\n")),
      };
    });
}

async function createHarness(t, coreHandler, options = {}) {
  let adapterBaseUrl = "";
  const coreServer = http.createServer(async (req, res) => {
    try {
      const rawBody = await readBody(req);
      await coreHandler({
        req,
        res,
        inbound: JSON.parse(rawBody.toString("utf8")),
        adapterBaseUrl,
      });
    } catch (error) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  const coreBaseUrl = await listen(coreServer);
  const adapter = new HttpAgentAdapter({
    host: "127.0.0.1",
    port: 0,
    coreUrl: coreBaseUrl,
    maxBodyBytes: 1024 * 1024,
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
    apiToken: API_TOKEN,
    agents: [{
      agentId: "meetings-agent",
      adapterId: "http-meetings-agent",
      sharedSecret: SHARED_SECRET,
    }],
  });
  adapterBaseUrl = await listen(adapter.server);
  t.after(async () => {
    await adapter.close();
    await new Promise((resolve, reject) =>
      coreServer.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { adapter, adapterBaseUrl };
}

function sendMessage(baseUrl, conversationKey = "local", headers = {}) {
  return fetch(
    `${baseUrl}/v1/agents/meetings-agent/conversations/${conversationKey}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ message: "Summarize the meeting" }),
    },
  );
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("HTTP config requires one registration bound to OMP_AGENT_ID", () => {
  const registration = {
    adapterId: "http-meetings-agent",
    agentId: "meetings-agent",
    sharedSecret: SHARED_SECRET,
    callbackUrl: "http://127.0.0.1:8765/core/events/meetings-agent",
  };
  const env = {
    OMP_AGENT_ID: "meetings-agent",
    OMP_ADAPTERS: JSON.stringify([registration]),
  };
  assert.deepEqual(loadHttpAdapterConfig(env).agents, [{
    agentId: "meetings-agent",
    adapterId: "http-meetings-agent",
    sharedSecret: SHARED_SECRET,
  }]);
  assert.throws(
    () => loadHttpAdapterConfig({ ...env, OMP_ADAPTERS: "[]" }),
    /must contain exactly one adapter registration/,
  );
  assert.throws(
    () => loadHttpAdapterConfig({ ...env, OMP_ADAPTERS: "" }),
    /OMP_ADAPTERS is required/,
  );
  assert.throws(
    () => loadHttpAdapterConfig({
      ...env,
      OMP_ADAPTERS: JSON.stringify([{ ...registration, agentId: undefined }]),
    }),
    /OMP_ADAPTERS\[0\]\.agentId must be a non-empty string/,
  );
  assert.throws(
    () => loadHttpAdapterConfig({ ...env, OMP_AGENT_ID: "other-agent" }),
    /does not match OMP_AGENT_ID "other-agent"/,
  );
  assert.throws(
    () => loadHttpAdapterConfig({
      ...env,
      OMP_ADAPTERS: JSON.stringify([{
        ...registration,
        callbackUrl: "http://127.0.0.1:8765/core/events",
      }]),
    }),
    /must target \/core\/events\/<agent-id>/,
  );
});

test("HTTP adapter returns a completed core turn without Pumble", async (t) => {
  let adapterBaseUrl = "";
  let coreFailure = null;
  let inbound = null;

  const coreServer = http.createServer(async (req, res) => {
    try {
      const rawBody = await readBody(req);
      inbound = {
        url: req.url,
        contentType: req.headers["content-type"],
        secret: req.headers["x-omp-bundler-adapter-secret"],
        body: JSON.parse(rawBody.toString("utf8")),
      };
      const correlationId = "correlation-1";
      const event = {
        version: "v1",
        type: "turn.reply",
        eventId: "event-1",
        conversationKey: inbound.body.conversationKey,
        correlationId,
        sequence: 4,
        occurredAt: new Date().toISOString(),
        text: "Meeting summarized.",
        attachments: [],
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      };
      const eventBody = JSON.stringify(event);

      const delta = {
        version: "v1",
        type: "turn.delta",
        eventId: "delta-1",
        conversationKey: inbound.body.conversationKey,
        correlationId,
        sequence: 2,
        occurredAt: new Date().toISOString(),
        text: "Meeting ",
      };
      const deltaBody = JSON.stringify(delta);
      const deltaCallback = await fetch(`${adapterBaseUrl}/core/events/meetings-agent`, {
        method: "POST",
        headers: signedEventHeaders(deltaBody, delta.type),
        body: deltaBody,
      });
      assert.equal(deltaCallback.status, 200);
      assert.deepEqual(await deltaCallback.json(), { status: "ok" });

      const duplicateDelta = await fetch(`${adapterBaseUrl}/core/events/meetings-agent`, {
        method: "POST",
        headers: signedEventHeaders(deltaBody, delta.type),
        body: deltaBody,
      });
      assert.equal(duplicateDelta.status, 200);
      assert.deepEqual(await duplicateDelta.json(), { status: "duplicate" });

      const emptyDeltaBody = JSON.stringify({ ...delta, eventId: "delta-empty", text: "" });
      const emptyDelta = await fetch(`${adapterBaseUrl}/core/events/meetings-agent`, {
        method: "POST",
        headers: signedEventHeaders(emptyDeltaBody, delta.type),
        body: emptyDeltaBody,
      });
      assert.equal(emptyDelta.status, 400);

      const nonStringDeltaBody = JSON.stringify({
        ...delta,
        eventId: "delta-number",
        text: 42,
      });
      const nonStringDelta = await fetch(`${adapterBaseUrl}/core/events/meetings-agent`, {
        method: "POST",
        headers: signedEventHeaders(nonStringDeltaBody, delta.type),
        body: nonStringDeltaBody,
      });
      assert.equal(nonStringDelta.status, 400);

      // Deliberately deliver the terminal callback before acceptance to prove
      // the synchronous facade cannot lose a fast core response.
      const callback = await fetch(`${adapterBaseUrl}/core/events/meetings-agent`, {
        method: "POST",
        headers: signedEventHeaders(eventBody, event.type),
        body: eventBody,
      });
      assert.equal(callback.status, 200);

      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "accepted", correlationId }));
    } catch (error) {
      coreFailure = error;
      res.writeHead(500);
      res.end("fake core failure");
    }
  });
  const coreBaseUrl = await listen(coreServer);
  const adapter = new HttpAgentAdapter({
    host: "127.0.0.1",
    port: 0,
    coreUrl: coreBaseUrl,
    maxBodyBytes: 1024 * 1024,
    turnTimeoutMs: 5_000,
    apiToken: API_TOKEN,
    agents: [
      {
        agentId: "meetings-agent",
        adapterId: "http-meetings-agent",
        sharedSecret: SHARED_SECRET,
      },
    ],
  });
  adapterBaseUrl = await listen(adapter.server);
  t.after(async () => {
    await adapter.close();
    await new Promise((resolve, reject) =>
      coreServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const health = await fetch(`${adapterBaseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "http-adapter",
    agents: ["meetings-agent"],
  });

  const unauthorized = await fetch(
    `${adapterBaseUrl}/v1/agents/meetings-agent/conversations/local/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Summarize the meeting" }),
    },
  );
  assert.equal(unauthorized.status, 401);

  const malformedStreamingRequest = await fetch(
    `${adapterBaseUrl}/v1/agents/meetings-agent/conversations/local/messages`,
    {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "" }),
    },
  );
  assert.equal(malformedStreamingRequest.status, 400);
  assert.equal(
    malformedStreamingRequest.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await malformedStreamingRequest.json(), {
    error: 'body must be {"message":"non-empty text"}',
  });

  const response = await fetch(
    `${adapterBaseUrl}/v1/agents/meetings-agent/conversations/local/messages`,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream; q=0",
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Summarize the meeting" }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    agentId: "meetings-agent",
    conversationKey: "local",
    correlationId: "correlation-1",
    text: "Meeting summarized.",
    attachments: [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  });
  assert.equal(coreFailure, null);
  assert.equal(inbound.url, "/v1/adapters/http-meetings-agent/messages");
  assert.equal(inbound.contentType, INBOUND_MESSAGE_MEDIA_TYPE);
  assert.equal(inbound.secret, SHARED_SECRET);
  assert.equal(inbound.body.conversationKey, "local");
  assert.deepEqual(inbound.body.speaker, { id: "http", displayName: "HTTP client" });
  assert.equal(inbound.body.text, "Summarize the meeting");
  assert.equal(inbound.body.addressed, true);
  assert.deepEqual(inbound.body.attachments, []);
});

test("HTTP adapter streams early callbacks in canonical sequence order", async (t) => {
  const callbackStatuses = [];
  const { adapterBaseUrl } = await createHarness(t, async ({
    res,
    inbound,
    adapterBaseUrl: callbackBaseUrl,
  }) => {
    const correlationId = "correlation-stream";
    const progress = turnEvent("turn.progress", 5, {
      eventId: "stream-progress-5",
      conversationKey: inbound.conversationKey,
      correlationId,
      message: "Writing summary",
    });
    const firstDelta = turnEvent("turn.delta", 2, {
      eventId: "stream-delta-2",
      conversationKey: inbound.conversationKey,
      correlationId,
      text: "Meeting ",
    });
    const secondDelta = turnEvent("turn.delta", 4, {
      eventId: "stream-delta-4",
      conversationKey: inbound.conversationKey,
      correlationId,
      text: "summarized.",
    });
    const terminal = turnEvent("turn.reply", 7, {
      eventId: "stream-reply-7",
      conversationKey: inbound.conversationKey,
      correlationId,
      text: "Meeting summarized.",
      attachments: [],
      usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    });

    for (const event of [progress, firstDelta]) {
      const callback = await postEvent(callbackBaseUrl, event);
      callbackStatuses.push([callback.status, await callback.json()]);
    }
    const duplicate = await postEvent(callbackBaseUrl, firstDelta);
    callbackStatuses.push([duplicate.status, await duplicate.json()]);

    const emptyDelta = { ...secondDelta, eventId: "stream-empty-delta", text: "" };
    const malformed = await postEvent(callbackBaseUrl, emptyDelta);
    callbackStatuses.push([malformed.status, await malformed.json()]);
    const mismatchedHeader = await postEvent(callbackBaseUrl, secondDelta, {
      headerType: "turn.progress",
    });
    callbackStatuses.push([mismatchedHeader.status, await mismatchedHeader.json()]);

    for (const event of [secondDelta, terminal]) {
      const callback = await postEvent(callbackBaseUrl, event);
      callbackStatuses.push([callback.status, await callback.json()]);
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId }));
  });

  const response = await sendMessage(adapterBaseUrl, "local", {
    accept: "application/json; q=0.2, Text/Event-Stream; charset=utf-8",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("transfer-encoding"), "chunked");
  const raw = await response.text();
  assert.equal(raw.endsWith("\n\n"), true);
  const events = parseSse(raw);
  assert.deepEqual(events.map(({ event, id }) => [event, id]), [
    ["accepted", undefined],
    ["delta", "2"],
    ["delta", "4"],
    ["progress", "5"],
    ["completed", "7"],
  ]);
  assert.deepEqual(events[0].data, { correlationId: "correlation-stream" });
  assert.equal(events[1].data.text, "Meeting ");
  assert.equal(events[2].data.text, "summarized.");
  assert.equal(events[3].data.message, "Writing summary");
  assert.deepEqual(events[4].data, turnEvent("turn.reply", 7, {
    eventId: "stream-reply-7",
    text: "Meeting summarized.",
    attachments: [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  }));
  assert.deepEqual(callbackStatuses, [
    [200, { status: "ok" }],
    [200, { status: "ok" }],
    [200, { status: "duplicate" }],
    [400, { error: "malformed outbound event" }],
    [400, { error: "malformed outbound event" }],
    [200, { status: "ok" }],
    [200, { status: "ok" }],
  ]);
});

test("HTTP adapter streams authoritative canonical errors and closes", async (t) => {
  const { adapterBaseUrl } = await createHarness(t, async ({
    res,
    inbound,
    adapterBaseUrl: callbackBaseUrl,
  }) => {
    const terminal = turnEvent("turn.error", 3, {
      eventId: "stream-error-3",
      conversationKey: inbound.conversationKey,
      correlationId: "correlation-error",
      code: "model_failed",
      message: "The model failed.",
      retryable: true,
    });
    const callback = await postEvent(callbackBaseUrl, terminal);
    assert.equal(callback.status, 200);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId: "correlation-error" }));
  });

  const response = await sendMessage(adapterBaseUrl, "local", {
    accept: "text/event-stream",
  });
  const events = parseSse(await response.text());
  assert.deepEqual(events.map(({ event, id }) => [event, id]), [
    ["accepted", undefined],
    ["error", "3"],
  ]);
  assert.deepEqual(events[1].data, turnEvent("turn.error", 3, {
    eventId: "stream-error-3",
    correlationId: "correlation-error",
    code: "model_failed",
    message: "The model failed.",
    retryable: true,
  }));
});

test("HTTP adapter preserves an early JSON terminal after delta buffer overflow", async (t) => {
  const { adapterBaseUrl } = await createHarness(t, async ({
    res,
    inbound,
    adapterBaseUrl: callbackBaseUrl,
  }) => {
    const correlationId = "correlation-overflow";
    for (const sequence of [1, 2]) {
      const delta = turnEvent("turn.delta", sequence, {
        eventId: `overflow-delta-${sequence}`,
        conversationKey: inbound.conversationKey,
        correlationId,
        text: "x".repeat(140 * 1024),
      });
      const callback = await postEvent(callbackBaseUrl, delta);
      assert.equal(callback.status, 200);
    }
    const terminal = turnEvent("turn.reply", 3, {
      eventId: "overflow-reply-3",
      conversationKey: inbound.conversationKey,
      correlationId,
      text: "Authoritative reply",
      attachments: [],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 },
    });
    const callback = await postEvent(callbackBaseUrl, terminal);
    assert.equal(callback.status, 200);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId }));
  });

  const response = await sendMessage(adapterBaseUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    agentId: "meetings-agent",
    conversationKey: "local",
    correlationId: "correlation-overflow",
    text: "Authoritative reply",
    attachments: [],
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 },
  });
});

test("HTTP disconnect keeps turn ownership until Core terminal", async (t) => {
  let inboundCount = 0;
  const { adapterBaseUrl } = await createHarness(t, async ({
    res,
    inbound,
    adapterBaseUrl: callbackBaseUrl,
  }) => {
    inboundCount += 1;
    const correlationId = `correlation-disconnect-${inboundCount}`;
    if (inboundCount === 2) {
      const terminal = turnEvent("turn.reply", 2, {
        eventId: "disconnect-reply-2",
        conversationKey: inbound.conversationKey,
        correlationId,
        text: "Second turn",
        attachments: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      });
      const callback = await postEvent(callbackBaseUrl, terminal);
      assert.equal(callback.status, 200);
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId }));
  });

  const first = await sendMessage(adapterBaseUrl, "local", {
    accept: "text/event-stream",
  });
  assert.equal(first.status, 200);
  const reader = first.body.getReader();
  const accepted = await reader.read();
  assert.equal(Buffer.from(accepted.value).toString("utf8").includes("event: accepted"), true);
  await reader.cancel();

  const overlapping = await sendMessage(adapterBaseUrl);
  assert.equal(overlapping.status, 409);
  assert.deepEqual(await overlapping.json(), {
    error: "conversation already has an in-flight turn",
  });
  assert.equal(inboundCount, 1);

  const terminal = turnEvent("turn.reply", 3, {
    eventId: "disconnect-reply-1",
    correlationId: "correlation-disconnect-1",
    text: "First turn finished",
    attachments: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  });
  const terminalCallback = await postEvent(adapterBaseUrl, terminal);
  assert.equal(terminalCallback.status, 200);
  assert.deepEqual(await terminalCallback.json(), { status: "ok" });
  await immediate();

  const next = await sendMessage(adapterBaseUrl);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).text, "Second turn");
  assert.equal(inboundCount, 2);
});

test("slow SSE clients never delay callback acknowledgement", async (t) => {
  const { adapter, adapterBaseUrl } = await createHarness(t, async ({ res }) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId: "correlation-slow" }));
  });

  const response = await sendMessage(adapterBaseUrl, "local", {
    accept: "text/event-stream",
  });
  const reader = response.body.getReader();
  await reader.read();
  const tracker = adapter.trackers.get("correlation-slow");
  assert(tracker?.active?.stream);
  const streamResponse = tracker.active.stream.res;
  const originalWrite = streamResponse.write;
  streamResponse.write = function (...args) {
    originalWrite.apply(this, args);
    return false;
  };

  const firstDelta = turnEvent("turn.delta", 1, {
    eventId: "slow-delta-1",
    correlationId: "correlation-slow",
    text: "first",
  });
  const firstCallback = await postEvent(adapterBaseUrl, firstDelta);
  assert.equal(firstCallback.status, 200);
  assert.equal(tracker.active.stream.blocked, true);

  const overflowingDelta = turnEvent("turn.delta", 2, {
    eventId: "slow-delta-2",
    correlationId: "correlation-slow",
    text: "x".repeat(300 * 1024),
  });
  const overflowCallback = await postEvent(adapterBaseUrl, overflowingDelta);
  assert.equal(overflowCallback.status, 200);
  assert.deepEqual(await overflowCallback.json(), { status: "ok" });
  assert.equal(tracker.active.stream, undefined);

  const overlapping = await sendMessage(adapterBaseUrl);
  assert.equal(overlapping.status, 409);
  const terminal = turnEvent("turn.reply", 3, {
    eventId: "slow-reply-3",
    correlationId: "correlation-slow",
    text: "Finished despite detached stream",
    attachments: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  });
  const terminalCallback = await postEvent(adapterBaseUrl, terminal);
  assert.equal(terminalCallback.status, 200);
  await reader.cancel().catch(() => {});
  await immediate();
  assert.equal(adapter.trackers.size, 0);
  assert.equal(adapter.inFlightConversations.size, 0);
});

test("turn timeout closes SSE and releases conversation ownership", async (t) => {
  let inboundCount = 0;
  const { adapter, adapterBaseUrl } = await createHarness(t, async ({
    res,
    inbound,
    adapterBaseUrl: callbackBaseUrl,
  }) => {
    inboundCount += 1;
    const correlationId = `correlation-timeout-${inboundCount}`;
    if (inboundCount === 2) {
      const terminal = turnEvent("turn.reply", 1, {
        eventId: "timeout-recovery-reply",
        conversationKey: inbound.conversationKey,
        correlationId,
        text: "Recovered",
        attachments: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      });
      const callback = await postEvent(callbackBaseUrl, terminal);
      assert.equal(callback.status, 200);
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId }));
  }, { turnTimeoutMs: 60 });

  const timedOut = await sendMessage(adapterBaseUrl, "local", {
    accept: "text/event-stream",
  });
  const timeoutEvents = parseSse(await timedOut.text());
  assert.deepEqual(timeoutEvents.map(({ event }) => event), ["accepted", "error"]);
  assert.deepEqual(timeoutEvents[1].data, { error: "agent turn timed out" });
  await immediate();
  assert.equal(adapter.trackers.size, 0);
  assert.equal(adapter.inFlightConversations.size, 0);

  const recovered = await sendMessage(adapterBaseUrl);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).text, "Recovered");
});

test("shutdown destroys streams and clears turn resources", async (t) => {
  const { adapter, adapterBaseUrl } = await createHarness(t, async ({ res }) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", correlationId: "correlation-shutdown" }));
  });

  const response = await sendMessage(adapterBaseUrl, "local", {
    accept: "text/event-stream",
  });
  assert.equal(response.status, 200);
  await adapter.close();
  await response.text().catch(() => "");
  await immediate();
  assert.equal(adapter.server.listening, false);
  assert.equal(adapter.trackers.size, 0);
  assert.equal(adapter.inFlightConversations.size, 0);
  assert.equal(adapter.recentEventIds.size, 0);
  assert.equal(adapter.recentEventOrder.length, 0);
});
