import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const loadSchema = async (name) =>
  JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

const inbound = ajv.compile(await loadSchema("inbound-v1.json"));
const accepted = ajv.compile(await loadSchema("inbound-accepted-v1.json"));
const outbound = ajv.compile(await loadSchema("outbound-v1.json"));

const inboundMessage = {
  messageId: "message-1",
  conversationKey: "conversation-1",
  speaker: { id: "user-1", displayName: "Ada" },
  text: "Please inspect this",
  attachments: [],
  addressed: true,
};

const envelope = {
  version: "v1",
  eventId: "event-1",
  conversationKey: "conversation-1",
  correlationId: "correlation-1",
  sequence: 1,
  occurredAt: "2026-07-29T01:00:00Z",
};

test("inbound accepts text and attachment-only messages", () => {
  assert.equal(inbound(inboundMessage), true, JSON.stringify(inbound.errors));
  assert.equal(
    inbound({
      ...inboundMessage,
      text: "",
      attachments: [{ path: "uploads/spec.pdf", mediaType: "application/pdf" }],
    }),
    true,
    JSON.stringify(inbound.errors),
  );
});

test("inbound rejects ambiguous activation and empty content", () => {
  assert.equal(inbound({ ...inboundMessage, addressed: [] }), false);
  assert.equal(inbound({ ...inboundMessage, text: "", attachments: [] }), false);
});

test("acceptance response requires a stable status and correlation id", () => {
  assert.equal(accepted({ status: "accepted", correlationId: "correlation-1" }), true);
  assert.equal(accepted({ status: "duplicate", correlationId: "correlation-1" }), true);
  assert.equal(accepted({ status: "conflict", correlationId: "correlation-1" }), false);
});

test("outbound validates terminal replies and rejects unsafe shape drift", () => {
  const reply = {
    ...envelope,
    type: "turn.reply",
    text: "Done",
    attachments: [],
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
  };

  assert.equal(outbound(reply), true, JSON.stringify(outbound.errors));
  assert.equal(outbound({ ...reply, text: "", attachments: [] }), false);
  assert.equal(outbound({ ...reply, occurredAt: "2026-07-29T09:00:00+08:00" }), false);
  assert.equal(outbound({ ...reply, platformMessageId: "pumble-1" }), false);
});

test("outbound validates exact non-empty turn.delta chunks", () => {
  const delta = {
    ...envelope,
    type: "turn.delta",
    sequence: 3,
    text: "next",
  };

  assert.equal(outbound(delta), true, JSON.stringify(outbound.errors));
  assert.equal(outbound({ ...delta, text: " " }), true, JSON.stringify(outbound.errors));
  assert.equal(outbound({ ...delta, text: "" }), false);
  assert.equal(outbound({ ...delta, text: 42 }), false);
});
