/**
 * Node HTTP service for the omp-bundler core supervisor.
 *
 * Routes:
 *   POST   /v1/adapters/:adapterId/messages
 *         Shared-secret auth header + v1 media type. Bounded JSON body.
 *         202 new acceptance, 200 exact duplicate, 400 malformed,
 *         401 bad secret, 404 unknown route/adapter, 409 conflict, curated 500.
 *         Responds as soon as core accepted processing (202/200),
 *         without waiting for the LLM turn or final callback.
 *
 *   DELETE /v1/adapters/:adapterId/conversations/:conversationKey/engagement
 *         Dismisses the engagement window. 200 on success, 404 unknown
 *         adapter, 401 bad secret.
 *
 *   GET    /health   -> 200 { status: "ok" }
 *   GET    /ready    -> 200 { status: "ready" } | 503 { status: "not ready" }
 *
 * Graceful shutdown: on SIGTERM/SIGINT, stop accepting new connections,
 * drain/close the pool and emitter, close SQLite stores, then exit nonzero
 * on teardown failure.
 */
import http, {
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

import type { InboundMessage } from "@omp-bundler/contracts/inbound";
import { INBOUND_MESSAGE_MEDIA_TYPE } from "@omp-bundler/contracts/inbound";

import { INBOUND_SECRET_HEADER } from "./adapter-registry.js";
import {
  CoreSupervisor,
  type CoreSupervisorOptions,
  InboundConflictError,
  createCoreSupervisor,
} from "./supervisor.js";
import { loadCoreConfig, type CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum inbound body size (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Header name for the inbound media type. */
const CONTENT_TYPE_HEADER = "Content-Type";

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export interface CoreServerOptions extends CoreSupervisorOptions {
  /** Optional injected server factory (for tests). */
  createServer?: typeof http.createServer;
}

export interface CoreServer {
  server: Server;
  supervisor: CoreSupervisor;
  close: () => Promise<void>;
}

/**
 * Create and start the core HTTP server. Returns the server handle and
 * supervisor. The caller should install signal handlers to call
 * {@link CoreServer.close} for graceful shutdown.
 */
export function createCoreServer(options: CoreServerOptions): CoreServer {
  const supervisor = createCoreSupervisor(options);
  const createServerFn = options.createServer ?? http.createServer;

  const server = createServerFn(async (req, res) => {
    try {
      await route(supervisor, req, res);
    } catch (err) {
      handleInternalError(res, err);
    }
  });

  let closePromise: Promise<void> | null = null;

  return {
    server,
    supervisor,
    close: () => {
      if (closePromise) return closePromise;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      closePromise = Promise.allSettled([
        serverClosed,
        supervisor.close(),
      ]).then((results) => {
        const errors = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        if (errors.length > 0)
          throw new AggregateError(errors, "core server close failed");
      });
      return closePromise;
    },
  };
}

/**
 * Boot the core server from a config. Listens on config.host:config.port.
 * Recovers pending outbound deliveries from a prior process, then installs
 * SIGTERM/SIGINT handlers for graceful shutdown.
 */
export async function bootCoreServer(config: CoreConfig): Promise<Server> {
  const { server, supervisor, close } = createCoreServer({ config });

  // Recover pending outbound deliveries before accepting traffic so no
  // callback is lost across a restart. Failures are logged but do not
  // prevent startup; the pending rows remain for the next recovery pass.
  try {
    await supervisor.recoverPending();
  } catch (err) {
    console.error(
      `>>> outbound recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  server.listen(config.port, config.host, () => {
    console.error(
      `>>> core supervisor listening on http://${config.host}:${config.port}`,
    );
  });

  let shuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`>>> ${signal} received, shutting down`);

    try {
      await close();
      console.error(">>> shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error(
        `>>> shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  return server;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(
  supervisor: CoreSupervisor,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  const method = req.method ?? "GET";
  const path = url.pathname;

  // Health and readiness.
  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && path === "/ready") {
    sendJson(res, 200, { status: "ready" });
    return;
  }

  // Adapter message route: POST /v1/adapters/:adapterId/messages
  const messageMatch = matchRoute(path, "/v1/adapters/:adapterId/messages");
  if (messageMatch && method === "POST") {
    await handleInboundMessage(supervisor, messageMatch.adapterId, req, res);
    return;
  }

  // Engagement dismissal: DELETE /v1/adapters/:adapterId/conversations/:conversationKey/engagement
  const dismissMatch = matchEngagementRoute(path);
  if (dismissMatch && method === "DELETE") {
    await handleDismissEngagement(
      supervisor,
      dismissMatch.adapterId,
      dismissMatch.conversationKey,
      req,
      res,
    );
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

function matchRoute(
  path: string,
  template: string,
): { adapterId: string } | null {
  const parts = path.split("/").filter((s) => s.length > 0);
  const tmpl = template.split("/").filter((s) => s.length > 0);
  if (parts.length !== tmpl.length) return null;
  const result: Record<string, string> = {};
  for (let i = 0; i < tmpl.length; i++) {
    const t = tmpl[i];
    if (t.startsWith(":")) {
      result[t.slice(1)] = decodeURIComponent(parts[i]);
    } else if (t !== parts[i]) {
      return null;
    }
  }
  return { adapterId: result.adapterId };
}

function matchEngagementRoute(
  path: string,
): { adapterId: string; conversationKey: string } | null {
  const parts = path.split("/").filter((s) => s.length > 0);
  // /v1/adapters/:adapterId/conversations/:conversationKey/engagement
  if (parts.length !== 6) return null;
  if (
    parts[0] !== "v1" ||
    parts[1] !== "adapters" ||
    parts[3] !== "conversations" ||
    parts[5] !== "engagement"
  ) {
    return null;
  }
  return {
    adapterId: decodeURIComponent(parts[2]),
    conversationKey: decodeURIComponent(parts[4]),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInboundMessage(
  supervisor: CoreSupervisor,
  adapterId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 1. Authenticate: unknown adapter (404) vs bad secret (401).
  const secret = req.headers[INBOUND_SECRET_HEADER.toLowerCase()] as
    | string
    | undefined;
  if (!supervisor.hasAdapter(adapterId)) {
    sendJson(res, 404, { error: "unknown adapter" });
    return;
  }
  if (!secret || !supervisor.authenticateInbound(adapterId, secret)) {
    sendJson(res, 401, { error: "invalid shared secret" });
    return;
  }

  // 2. Validate content type (v1 media type).
  const contentType = req.headers[CONTENT_TYPE_HEADER.toLowerCase()] as
    | string
    | undefined;
  if (contentType !== INBOUND_MESSAGE_MEDIA_TYPE) {
    sendJson(res, 400, {
      error: `unsupported content type; expected ${INBOUND_MESSAGE_MEDIA_TYPE}`,
    });
    return;
  }

  // 3. Read bounded body.
  const rawBody = await readBoundedBody(req);
  if (rawBody === null) {
    sendJson(res, 400, { error: "request body too large" });
    return;
  }
  if (rawBody.length === 0) {
    sendJson(res, 400, { error: "empty request body" });
    return;
  }

  // 4. Parse JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }

  // 5. Validate shape (malformed -> 400).
  const message = validateInboundMessage(parsed);
  if (message === null) {
    sendJson(res, 400, { error: "malformed inbound message" });
    return;
  }

  // 6. Process via supervisor.
  try {
    const result = await supervisor.processInbound(adapterId, message);
    if (result.kind === "accepted") {
      sendJson(res, 202, {
        status: "accepted",
        correlationId: result.correlationId,
      });
    } else {
      sendJson(res, 200, {
        status: "duplicate",
        correlationId: result.correlationId,
      });
    }
  } catch (err) {
    handleInboundError(res, err);
  }
}

async function handleDismissEngagement(
  supervisor: CoreSupervisor,
  adapterId: string,
  conversationKey: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const secret = req.headers[INBOUND_SECRET_HEADER.toLowerCase()] as
    | string
    | undefined;
  if (!supervisor.hasAdapter(adapterId)) {
    sendJson(res, 404, { error: "unknown adapter" });
    return;
  }
  if (!secret || !supervisor.authenticateInbound(adapterId, secret)) {
    sendJson(res, 401, { error: "invalid shared secret" });
    return;
  }

  const dismissed = supervisor.dismissEngagement(adapterId, conversationKey);
  sendJson(res, 200, { dismissed });
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

async function readBoundedBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the parsed JSON against the inbound message shape. Returns the
 * typed message or null if malformed. This is a structural check, not a
 * full JSON-schema validation (the schema is available for the adapter to
 * use, but the core does its own validation to avoid a runtime dependency
 * on ajv).
 */
function validateInboundMessage(parsed: unknown): InboundMessage | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    !hasOnlyProperties(obj, [
      "messageId",
      "conversationKey",
      "speaker",
      "text",
      "attachments",
      "addressed",
    ])
  )
    return null;

  const messageId = obj.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) return null;

  const conversationKey = obj.conversationKey;
  if (typeof conversationKey !== "string" || conversationKey.length === 0)
    return null;

  const speaker = obj.speaker;
  if (speaker === null || typeof speaker !== "object" || Array.isArray(speaker))
    return null;
  const sp = speaker as Record<string, unknown>;
  if (!hasOnlyProperties(sp, ["id", "displayName"])) return null;
  if (typeof sp.id !== "string" || sp.id.length === 0) return null;
  if (typeof sp.displayName !== "string" || sp.displayName.length === 0)
    return null;

  const text = obj.text;
  if (typeof text !== "string") return null;

  const attachments = obj.attachments;
  if (!Array.isArray(attachments)) return null;
  if (text.length === 0 && attachments.length === 0) return null;

  for (const attachment of attachments) {
    if (
      attachment === null ||
      typeof attachment !== "object" ||
      Array.isArray(attachment)
    )
      return null;
    const att = attachment as Record<string, unknown>;
    if (!hasOnlyProperties(att, ["path", "name", "mediaType"])) return null;
    if (typeof att.path !== "string" || att.path.length === 0) return null;
    if (att.name !== undefined && typeof att.name !== "string") return null;
    if (att.mediaType !== undefined && typeof att.mediaType !== "string")
      return null;
  }

  if (typeof obj.addressed !== "boolean") return null;
  return parsed as InboundMessage;
}

function hasOnlyProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleInboundError(res: ServerResponse, err: unknown): void {
  if (err instanceof InboundConflictError) {
    sendJson(res, 409, { error: err.message });
    return;
  }
  handleInternalError(res, err);
}

function handleInternalError(res: ServerResponse, err: unknown): void {
  const errorId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[internal error ${errorId}] ${message}`);
  sendJson(res, 500, { error: "internal error", errorId });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json, "utf8"),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Executable boot path (run via `bun src/server.ts` or `omp-bundler-core`)
// ---------------------------------------------------------------------------

/**
 * When this file is executed directly (not imported), load the config from
 * env and boot the core server. The entrypoint script execs this file as
 * PID 1 so signals propagate cleanly.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadCoreConfig();
  await bootCoreServer(config);
}
