import http from "node:http";
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { loadBridgeConfig } from "./config.js";
import { buildManifest } from "./manifest.js";
import { PumbleApi } from "./pumble-api.js";
import { verifyPumbleSignature } from "./security.js";
import { TokenStore } from "./token-store.js";
import { TargetStore, type Target } from "./target-store.js";
import { PumbleAttachmentSender } from "./attachment-sender.js";
import { DeliveryStore } from "./delivery-store.js";
import { parseNewMessage, normalizePumbleMessage, type NormalizeContext } from "./pumble-event.js";
import { savePumbleFiles, type PumbleMessageFilesEvent } from "./pumble-files.js";
import { PumbleRenderer, type ConversationResolver } from "./pumble-renderer.js";
import type { OutboundEvent } from "@omp-bundler/contracts/outbound";
import { OUTBOUND_EVENT_MEDIA_TYPE, OUTBOUND_EVENT_SIGNATURE_HEADER, ADAPTER_API_VERSION } from "@omp-bundler/contracts/outbound";
import { INBOUND_MESSAGE_MEDIA_TYPE } from "@omp-bundler/contracts/inbound";

/** Header carrying the presented shared secret on an inbound adapter request. */
const INBOUND_SECRET_HEADER = "X-OMP-Bundler-Adapter-Secret";
const config = loadBridgeConfig();
await mkdir(config.pumbleDataDir, { recursive: true });

const pumble = new PumbleApi(config);
const tokens = new TokenStore(path.join(config.pumbleDataDir, "workspaces.json"));
const targetStore = new TargetStore(path.join(config.pumbleDataDir, "targets.json"));
const deliveryStore = new DeliveryStore(path.join(config.pumbleDataDir, "delivered-events.json"));

const attachmentSender = new PumbleAttachmentSender(config, pumble);

const resolver: ConversationResolver = async (conversationKey, correlationId) => {
  const target = await targetStore.resolve(conversationKey, correlationId);
  if (!target) return null;
  const workspaceTokens = await tokens.getWorkspace(target.workspaceId);
  if (!workspaceTokens?.botToken) {
    throw new Error(`no bot token for workspace ${target.workspaceId}`);
  }
  return {
    appKey: config.appKey,
    botToken: workspaceTokens.botToken,
    channelId: target.channelId,
    triggerMessageId: target.triggerMessageId,
    threadRootId: target.threadRootId,
  };
};

const renderer = new PumbleRenderer({
  pumble,
  resolver,
  logger: console,
  attachmentSender,
});

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble adapter request failed:", message);
    sendText(res, 500, "internal error");
  }
});

server.listen(config.port, config.host, () => {

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(">>> Pumble adapter shutdown failed:", error.message);
        process.exitCode = 1;
      }
    });
  });
}
  console.log(`>>> Pumble adapter listening on http://${config.host}:${config.port}`);
});

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", service: "pumble-adapter" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pumble/manifest.json") {
    sendJson(res, 200, buildManifest(config));
    return;
  }

  if (req.method === "GET" && url.pathname === "/pumble/oauth/callback") {
    await handleOAuthCallback(url, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/pumble/events") {
    await handlePumbleEvents(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/core/events") {
    await handleCoreEvents(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/download") {
    await handleDownload(url, res);
    return;
  }

  sendText(res, 404, "not found");
}

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

async function handleOAuthCallback(url: URL, res: http.ServerResponse) {
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    sendText(res, 400, "Missing code query parameter");
    return;
  }
  if (!config.appId || !config.clientSecret) {
    sendText(res, 400, "Missing Pumble app credentials");
    return;
  }

  try {
    const payload = await pumble.exchangeCode(code);
    await tokens.saveOAuthPayload(payload);
    sendText(res, 200, "Pumble authorization completed. You can close this window.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble OAuth exchange failed:", message);
    sendText(res, 401, "Could not authorize Pumble app.");
  }
}

// ---------------------------------------------------------------------------
// Pumble webhook: NEW_MESSAGE ingestion
// ---------------------------------------------------------------------------

async function handlePumbleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  const rawBody = await readBody(req, config.pumbleEventMaxBytes);
  if (!rawBody) {
    sendText(res, 413, "Request body exceeds maximum size");
    return;
  }

  if (
    !verifyPumbleSignature(
      req.headers,
      rawBody,
      config.signingSecret,
      config.signatureToleranceSeconds,
    )
  ) {
    sendText(res, 401, "Invalid signature");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  const eventType = typeof payload.eventType === "string" ? payload.eventType : "";
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";

  if (workspaceId && (eventType === "APP_UNAUTHORIZED" || eventType === "APP_UNINSTALLED")) {
    await tokens.deleteWorkspace(workspaceId);
    sendText(res, 200, "ok");
    return;
  }

  if (eventType !== "NEW_MESSAGE") {
    sendText(res, 200, "ok");
    return;
  }

  const result = await processNewMessage(payload);
  if (!result.ok) {
    // Missing tokens, context, or download failures are explicit, retryable.
    // 5xx so Pumble retries; safe failures are never silent.
    sendText(res, 500, result.error || "processing failed");
    return;
  }

  sendText(res, 200, "ok");
}

interface NewMessageResult {
  ok: boolean;
  error?: string;
}

async function processNewMessage(payload: Record<string, unknown>): Promise<NewMessageResult> {
  const event = parseNewMessage(payload);
  if (!event) {
    // Malformed payload: not retryable, but we ack so Pumble does not retry.
    return { ok: true };
  }

  // Load workspace tokens; missing tokens is explicit and retryable.
  const workspaceTokens = await tokens.getWorkspace(event.workspaceId);
  if (!workspaceTokens) {
    return {
      ok: false,
      error: `no workspace tokens for workspace ${event.workspaceId}`,
    };
  }
  if (!workspaceTokens.botToken || !workspaceTokens.accessToken) {
    return {
      ok: false,
      error: `workspace ${event.workspaceId} is missing bot or access token`,
    };
  }
  if (!config.appKey) {
    return {
      ok: false,
      error: "PUMBLE_APP_KEY is not configured",
    };
  }

  // Resolve channel type from the Pumble API (authoritative).
  let channelType = event.channelType || "";
  if (!channelType) {
    try {
      const channelResponse = await pumble.getChannel(
        config.appKey,
        workspaceTokens.botToken,
        event.channelId,
      );
      channelType = stringValue(channelResponse.type) || stringValue(channelResponse.channelType) || "";
    } catch (error) {
      return {
        ok: false,
        error: `channel resolution failed for ${event.channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (!channelType) {
    return {
      ok: false,
      error: `could not determine channel type for ${event.channelId}`,
    };
  }

  // Resolve author display name from the Pumble API.
  let authorDisplayName = "";
  try {
    const userResponse = await pumble.getUser(
      config.appKey,
      workspaceTokens.botToken,
      event.authorId,
    );
    authorDisplayName =
      stringValue(userResponse.name) ||
      stringValue(userResponse.displayName) ||
      stringValue(userResponse.username) ||
      "";
  } catch (error) {
    return {
      ok: false,
      error: `user resolution failed for ${event.authorId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!authorDisplayName) {
    return {
      ok: false,
      error: `could not determine display name for user ${event.authorId}`,
    };
  }

  // Download attachments.
  const filesEvent: PumbleMessageFilesEvent = {
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    authorId: event.authorId,
    messageId: event.messageId,
    threadRootId: event.threadRootId,
    files: event.files,
  };
  let savedFiles;
  try {
    savedFiles = await savePumbleFiles(config, pumble, workspaceTokens, filesEvent);
  } catch (error) {
    return {
      ok: false,
      error: `attachment download failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Check for download failures (individual file errors).
  const failedDownloads = savedFiles.filter((f) => f.error);
  if (failedDownloads.length > 0) {
    return {
      ok: false,
      error: `attachment download failed: ${failedDownloads.map((f) => f.error).join("; ")}`,
    };
  }

  // Build attachment refs for the inbound message.
  const attachments = savedFiles
    .filter((f) => f.workspacePath)
    .map((f) => ({
      path: f.workspacePath!,
      ...(f.name ? { name: f.name } : {}),
      ...(f.mimeType ? { mediaType: f.mimeType } : {}),
    }));

  // Normalize the Pumble message into the inbound contract.
  const normalizeContext: NormalizeContext = {
    botId: workspaceTokens.botId,
    channelType,
    authorDisplayName,
    attachments,
  };
  const inboundMessage = normalizePumbleMessage(event, normalizeContext);
  if (!inboundMessage) {
    // Dropped (ephemeral, echo, bot-authored, empty): ack so Pumble does not retry.
    return { ok: true };
  }

  // Validate core integration config.
  if (!config.coreUrl) {
    return {
      ok: false,
      error: "PUMBLE_CORE_URL is not configured",
    };
  }
  if (!config.coreSharedSecret) {
    return {
      ok: false,
      error: "PUMBLE_CORE_SHARED_SECRET is not configured",
    };
  }

  // Resolve the target for outbound callbacks.
  const target: Target = {
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    triggerMessageId: event.messageId,
    threadRootId: event.threadRootId,
  };

  // Persist target under conversationKey BEFORE the core POST so an early
  // outbound callback can resolve via conversationKey fallback.
  await targetStore.putByConversation(inboundMessage.conversationKey, target);

  // POST the inbound message to the omp-bundler core.
  const body = JSON.stringify(inboundMessage);
  let correlationId: string;
  try {
    correlationId = await postToCore(body);
  } catch (error) {
    return {
      ok: false,
      error: `core POST failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Bind the returned correlationId to the same target AFTER acceptance.
  await targetStore.bindCorrelation(inboundMessage.conversationKey, correlationId);

  return { ok: true };
}

/**
 * POST the inbound message to the omp-bundler core endpoint and validate
 * the acceptance response. Returns the correlationId on success.
 */
async function postToCore(body: string): Promise<string> {
  const endpoint = `${config.coreUrl}/v1/adapters/${config.coreAdapterId}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": INBOUND_MESSAGE_MEDIA_TYPE,
      [INBOUND_SECRET_HEADER]: config.coreSharedSecret,
    },
    body,
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });

  if (response.status === 202 || response.status === 200) {
    const payload = (await response.json()) as { status: string; correlationId: string };
    if (payload.status !== "accepted" && payload.status !== "duplicate") {
      throw new Error(`core returned unexpected status: ${payload.status}`);
    }
    if (!payload.correlationId) {
      throw new Error("core returned empty correlationId");
    }
    return payload.correlationId;
  }

  // 409 conflict: same messageId with different payload. Not retryable.
  if (response.status === 409) {
    throw new Error(`core rejected: conflict (409)`);
  }

  // 4xx (other than 409): bad request, not retryable.
  if (response.status >= 400 && response.status < 500) {
    throw new Error(`core rejected: HTTP ${response.status}`);
  }

  // 5xx: retryable.
  const text = await response.text().catch(() => "");
  throw new Error(`core returned HTTP ${response.status}${text ? `: ${text}` : ""}`);
}

// ---------------------------------------------------------------------------
// Core outbound callback: /core/events
// ---------------------------------------------------------------------------

async function handleCoreEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  const rawBody = await readBody(req, config.coreEventMaxBytes);
  if (!rawBody) {
    sendText(res, 413, "Request body exceeds maximum size");
    return;
  }

  // Verify the exact-body HMAC signature.
  const signatureHeader = headerValue(req.headers[OUTBOUND_EVENT_SIGNATURE_HEADER.toLowerCase()]);
  if (!signatureHeader || !verifyCoreSignature(signatureHeader, rawBody, config.coreSharedSecret)) {
    sendText(res, 401, "Invalid signature");
    return;
  }

  // Verify content type.
  const contentType = headerValue(req.headers["content-type"]);
  if (contentType !== OUTBOUND_EVENT_MEDIA_TYPE) {
    sendText(res, 415, `Unsupported media type; expected ${OUTBOUND_EVENT_MEDIA_TYPE}`);
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  // Validate the v1 event shape.
  const validationError = validateOutboundEvent(payload);
  if (validationError) {
    sendText(res, 400, validationError);
    return;
  }

  const event = payload as unknown as OutboundEvent;

  if (await deliveryStore.hasCompleted(event.eventId)) {
    if (event.type === "turn.reply" || event.type === "turn.error") {
      await targetStore.forgetCorrelation(event.correlationId);
    }
    sendText(res, 200, "ok");
    return;
  }
  // Deliver the event through the renderer. Only 2xx after the renderer
  // succeeds; 5xx on retry-safe failure so the core redelivers.
  try {
    await renderer.render(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(">>> Pumble renderer failed:", message);
    sendText(res, 500, "rendering failed");
    return;
  }

  // Persist dedupe before acknowledging; terminal targets can then be released.
  await deliveryStore.markCompleted(event.eventId);

  if (event.type === "turn.reply" || event.type === "turn.error") {
    await targetStore.forgetCorrelation(event.correlationId);
  }

  sendText(res, 200, "ok");
}

/**
 * Verify the core outbound signature: the header is `sha256=<hex>` and the
 * digest is HMAC-SHA256(sharedSecret, exactRequestBody) using the same
 * shared secret as the inbound auth.
 */
function verifyCoreSignature(sigHeader: string, rawBody: Buffer, secret: string): boolean {
  if (!secret) {
    return false;
  }
  const prefix = "sha256=";
  if (!sigHeader.startsWith(prefix)) {
    return false;
  }
  const provided = sigHeader.slice(prefix.length);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Validate the minimal v1 outbound event shape. Checks the required base
 * fields and the discriminated variant fields without full schema validation.
 */
function validateOutboundEvent(payload: Record<string, unknown>): string | null {
  if (payload.version !== ADAPTER_API_VERSION) {
    return `version must be "${ADAPTER_API_VERSION}"`;
  }
  const type = payload.type;
  if (typeof type !== "string") {
    return "type must be a string";
  }
  const validTypes: Record<string, true> = {
    "turn.started": true,
    "turn.progress": true,
    "turn.reply": true,
    "presence.changed": true,
    "turn.error": true,
  };
  if (!validTypes[type]) {
    return `unknown event type: ${type}`;
  }
  if (typeof payload.eventId !== "string" || !payload.eventId) {
    return "eventId must be a non-empty string";
  }
  if (typeof payload.conversationKey !== "string" || !payload.conversationKey) {
    return "conversationKey must be a non-empty string";
  }
  if (typeof payload.correlationId !== "string" || !payload.correlationId) {
    return "correlationId must be a non-empty string";
  }
  if (typeof payload.sequence !== "number" || !Number.isFinite(payload.sequence) || payload.sequence < 1) {
    return "sequence must be a positive integer";
  }
  if (typeof payload.occurredAt !== "string" || !payload.occurredAt) {
    return "occurredAt must be a non-empty string";
  }

  if (type === "turn.progress" && (typeof payload.message !== "string" || !payload.message)) {
    return "turn.progress requires a non-empty message";
  }
  if (type === "turn.reply") {
    if (typeof payload.text !== "string") {
      return "turn.reply requires a string text";
    }
    if (!Array.isArray(payload.attachments)) {
      return "turn.reply requires an attachments array";
    }
  }
  if (type === "turn.error") {
    if (typeof payload.code !== "string" || !payload.code) {
      return "turn.error requires a non-empty code";
    }
    if (typeof payload.message !== "string") {
      return "turn.error requires a string message";
    }
    if (typeof payload.retryable !== "boolean") {
      return "turn.error requires a boolean retryable";
    }
  }
  if (type === "presence.changed") {
    const presence = payload.presence;
    const validPresence: Record<string, true> = { active: true, idle: true, offline: true };
    if (typeof presence !== "string" || !validPresence[presence]) {
      return "presence.changed requires a valid presence value";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signed download route: GET /download
// ---------------------------------------------------------------------------

async function handleDownload(url: URL, res: http.ServerResponse) {
  const queryPath = url.searchParams.get("p") || "";
  const queryExp = url.searchParams.get("exp") || "";
  const querySig = url.searchParams.get("sig") || "";

  let verifiedPath: string;
  try {
    verifiedPath = PumbleAttachmentSender.verifyDownloadLink(
      config,
      queryPath,
      queryExp,
      querySig,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Expired or tampered links are 403 (forbidden), not 500.
    sendText(res, 403, message);
    return;
  }

  // Resolve the workspace-relative path and verify containment.
  let absolutePath: string;
  try {
    absolutePath = PumbleAttachmentSender.resolveWorkspacePathStatic(config, verifiedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Traversal escape is 403 (forbidden).
    sendText(res, 403, message);
    return;
  }
  // Serve only regular files.
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    sendText(res, 404, "File not found");
    return;
  }
  if (!fileStat.isFile()) {
    sendText(res, 403, "Requested path is not a regular file");
    return;
  }
  if (fileStat.size > config.downloadMaxBytes) {
    sendText(res, 403, "File exceeds maximum download size");
    return;
  }

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(fileStat.size),
  });
  const stream = createReadStream(absolutePath);
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
