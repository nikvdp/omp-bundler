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
import { HttpAgentAdapter } from "../src/server.ts";

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
        sequence: 1,
        occurredAt: new Date().toISOString(),
        text: "Meeting summarized.",
        attachments: [],
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      };
      const eventBody = JSON.stringify(event);

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

  const response = await fetch(
    `${adapterBaseUrl}/v1/agents/meetings-agent/conversations/local/messages`,
    {
      method: "POST",
      headers: {
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
