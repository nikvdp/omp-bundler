import * as crypto from "node:crypto";
import * as http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  INBOUND_MESSAGE_MEDIA_TYPE,
  type InboundMessage,
  type InboundMessageAccepted,
} from "@omp-bundler/contracts/inbound";
import {
  ADAPTER_API_VERSION,
  OUTBOUND_EVENT_MEDIA_TYPE,
  OUTBOUND_EVENT_SIGNATURE_HEADER,
  OUTBOUND_EVENT_TYPE_HEADER,
  type OutboundEvent,
  type TurnErrorEvent,
  type TurnReplyEvent,
} from "@omp-bundler/contracts/outbound";

const INBOUND_SECRET_HEADER = "X-OMP-Bundler-Adapter-Secret";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONVERSATION_KEY_LENGTH = 512;
const RECENT_EVENT_LIMIT = 1_000;

type TerminalEvent = TurnReplyEvent | TurnErrorEvent;

export interface HttpAgentRegistration {
  agentId: string;
  adapterId: string;
  sharedSecret: string;
}

export interface HttpAdapterConfig {
  host: string;
  port: number;
  coreUrl: string;
  maxBodyBytes: number;
  turnTimeoutMs: number;
  apiToken?: string;
  agents: readonly HttpAgentRegistration[];
}

interface PendingTurn {
  conversationKey: string;
  resolve: (event: TerminalEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onClose: () => void;
}

interface BufferedTerminal {
  event: TerminalEvent;
  timer: NodeJS.Timeout;
}

class PublicError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export class HttpAgentAdapter {
  readonly server: http.Server;
  readonly config: HttpAdapterConfig;
  private readonly agents = new Map<string, HttpAgentRegistration>();
  private readonly inFlightConversations = new Set<string>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly bufferedTerminals = new Map<string, BufferedTerminal>();
  private readonly recentEventIds = new Set<string>();
  private readonly recentEventOrder: string[] = [];
  private closePromise: Promise<void> | null = null;

  constructor(config: HttpAdapterConfig) {
    this.config = config;
    for (const registration of config.agents) {
      if (this.agents.has(registration.agentId)) {
        throw new Error(`duplicate HTTP agent registration: ${registration.agentId}`);
      }
      this.agents.set(registration.agentId, registration);
    }
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((error: unknown) => {
        console.error(
          ">>> HTTP adapter request failed:",
          error instanceof Error ? error.message : String(error),
        );
        sendJson(res, 500, { error: "internal server error" });
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    for (const pending of [...this.pendingTurns.values()]) {
      pending.reject(new PublicError(503, "HTTP adapter is shutting down"));
    }
    for (const buffered of this.bufferedTerminals.values()) {
      clearTimeout(buffered.timer);
    }
    this.bufferedTerminals.clear();
    if (!this.server.listening) return Promise.resolve();
    this.closePromise = new Promise<void>((resolveClose, rejectClose) => {
      this.server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    return this.closePromise;
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "http-adapter",
        agents: [...this.agents.keys()].sort(),
      });
      return;
    }

    const callbackAgentId = matchCallbackRoute(url.pathname);
    if (req.method === "POST" && callbackAgentId !== null) {
      await this.handleCoreEvent(callbackAgentId, req, res);
      return;
    }

    const messageRoute = matchMessageRoute(url.pathname);
    if (req.method === "POST" && messageRoute !== null) {
      await this.handleMessage(messageRoute, req, res);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  private async handleMessage(
    route: { agentId: string; conversationKey: string },
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.authenticatePublic(req)) {
      sendJson(res, 401, { error: "invalid bearer token" });
      return;
    }

    const registration = this.agents.get(route.agentId);
    if (!registration) {
      sendJson(res, 404, { error: "unknown agent" });
      return;
    }
    if (
      route.conversationKey.length === 0 ||
      route.conversationKey.length > MAX_CONVERSATION_KEY_LENGTH
    ) {
      sendJson(res, 400, {
        error: `conversationKey must contain 1-${MAX_CONVERSATION_KEY_LENGTH} characters`,
      });
      return;
    }
    if (!isJsonContentType(headerValue(req.headers["content-type"]))) {
      sendJson(res, 415, { error: "content-type must be application/json" });
      return;
    }

    const rawBody = await readBody(req, this.config.maxBodyBytes);
    if (rawBody === null) {
      sendJson(res, 413, { error: "request body too large" });
      return;
    }
    const message = parsePublicMessage(rawBody);
    if (message === null) {
      sendJson(res, 400, { error: 'body must be {"message":"non-empty text"}' });
      return;
    }

    const conversation = JSON.stringify([route.agentId, route.conversationKey]);
    if (this.inFlightConversations.has(conversation)) {
      sendJson(res, 409, { error: "conversation already has an in-flight turn" });
      return;
    }
    this.inFlightConversations.add(conversation);

    try {
      const startedAt = Date.now();
      const correlationId = await this.postToCore(
        registration,
        route.conversationKey,
        message,
      );
      const remainingMs = Math.max(
        1,
        this.config.turnTimeoutMs - (Date.now() - startedAt),
      );
      const terminal = await this.awaitTerminal(
        correlationId,
        route.conversationKey,
        remainingMs,
        res,
      );

      if (terminal.type === "turn.error") {
        sendJson(res, 502, {
          agentId: route.agentId,
          conversationKey: route.conversationKey,
          correlationId,
          error: {
            code: terminal.code,
            message: terminal.message,
            retryable: terminal.retryable,
          },
        });
        return;
      }

      sendJson(res, 200, {
        agentId: route.agentId,
        conversationKey: route.conversationKey,
        correlationId,
        text: terminal.text,
        attachments: terminal.attachments,
        usage: terminal.usage,
      });
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof PublicError ? error.status : 502;
      sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightConversations.delete(conversation);
    }
  }

  private async postToCore(
    registration: HttpAgentRegistration,
    conversationKey: string,
    message: string,
  ): Promise<string> {
    const body: InboundMessage = {
      messageId: crypto.randomUUID(),
      conversationKey,
      speaker: { id: "http", displayName: "HTTP client" },
      text: message,
      attachments: [],
      addressed: true,
    };

    let response: Response;
    try {
      response = await fetch(
        `${this.config.coreUrl}/v1/adapters/${encodeURIComponent(registration.adapterId)}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": INBOUND_MESSAGE_MEDIA_TYPE,
            [INBOUND_SECRET_HEADER]: registration.sharedSecret,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.turnTimeoutMs),
        },
      );
    } catch (error) {
      throw new PublicError(
        502,
        `core request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const raw = await response.text();
    let accepted: Partial<InboundMessageAccepted> | null = null;
    try {
      accepted = JSON.parse(raw) as Partial<InboundMessageAccepted>;
    } catch {
      // Report the status and bounded text below.
    }
    if (
      (response.status !== 200 && response.status !== 202) ||
      typeof accepted?.correlationId !== "string" ||
      accepted.correlationId.length === 0
    ) {
      throw new PublicError(
        502,
        `core returned HTTP ${response.status}${raw ? `: ${raw.slice(0, 500)}` : ""}`,
      );
    }
    return accepted.correlationId;
  }

  private awaitTerminal(
    correlationId: string,
    conversationKey: string,
    timeoutMs: number,
    res: http.ServerResponse,
  ): Promise<TerminalEvent> {
    const buffered = this.bufferedTerminals.get(correlationId);
    if (buffered) {
      clearTimeout(buffered.timer);
      this.bufferedTerminals.delete(correlationId);
      if (buffered.event.conversationKey !== conversationKey) {
        throw new PublicError(502, "core returned a mismatched conversation");
      }
      return Promise.resolve(buffered.event);
    }

    return new Promise<TerminalEvent>((resolveTurn, rejectTurn) => {
      const cleanup = () => {
        const pending = this.pendingTurns.get(correlationId);
        if (pending?.onClose === onClose) this.pendingTurns.delete(correlationId);
        clearTimeout(timer);
        res.off("close", onClose);
      };
      const resolvePending = (event: TerminalEvent) => {
        cleanup();
        if (event.conversationKey !== conversationKey) {
          rejectTurn(new PublicError(502, "core returned a mismatched conversation"));
        } else {
          resolveTurn(event);
        }
      };
      const rejectPending = (error: Error) => {
        cleanup();
        rejectTurn(error);
      };
      const onClose = () => {
        if (!res.writableEnded) {
          rejectPending(new PublicError(499, "client disconnected"));
        }
      };
      const timer = setTimeout(
        () => rejectPending(new PublicError(504, "agent turn timed out")),
        timeoutMs,
      );
      timer.unref();
      this.pendingTurns.set(correlationId, {
        conversationKey,
        resolve: resolvePending,
        reject: rejectPending,
        timer,
        onClose,
      });
      res.once("close", onClose);
    });
  }

  private async handleCoreEvent(
    agentId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const registration = this.agents.get(agentId);
    if (!registration) {
      sendJson(res, 404, { error: "unknown agent" });
      return;
    }
    const rawBody = await readBody(req, this.config.maxBodyBytes);
    if (rawBody === null) {
      sendJson(res, 413, { error: "request body too large" });
      return;
    }
    const signature = headerValue(
      req.headers[OUTBOUND_EVENT_SIGNATURE_HEADER.toLowerCase()],
    );
    if (!signature || !verifySignature(signature, rawBody, registration.sharedSecret)) {
      sendJson(res, 401, { error: "invalid signature" });
      return;
    }
    if (headerValue(req.headers["content-type"]) !== OUTBOUND_EVENT_MEDIA_TYPE) {
      sendJson(res, 415, { error: "unsupported content type" });
      return;
    }

    const event = parseOutboundEvent(rawBody);
    if (
      event === null ||
      headerValue(req.headers[OUTBOUND_EVENT_TYPE_HEADER.toLowerCase()]) !== event.type
    ) {
      sendJson(res, 400, { error: "malformed outbound event" });
      return;
    }
    if (this.recentEventIds.has(event.eventId)) {
      sendJson(res, 200, { status: "duplicate" });
      return;
    }

    if (event.type === "turn.reply" || event.type === "turn.error") {
      const pending = this.pendingTurns.get(event.correlationId);
      if (pending) {
        pending.resolve(event);
      } else {
        this.bufferTerminal(event);
      }
    }
    this.rememberEvent(event.eventId);
    sendJson(res, 200, { status: "ok" });
  }

  private bufferTerminal(event: TerminalEvent): void {
    const existing = this.bufferedTerminals.get(event.correlationId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.bufferedTerminals.delete(event.correlationId);
    }, this.config.turnTimeoutMs);
    timer.unref();
    this.bufferedTerminals.set(event.correlationId, { event, timer });
  }

  private rememberEvent(eventId: string): void {
    this.recentEventIds.add(eventId);
    this.recentEventOrder.push(eventId);
    if (this.recentEventOrder.length > RECENT_EVENT_LIMIT) {
      this.recentEventIds.delete(this.recentEventOrder.shift()!);
    }
  }

  private authenticatePublic(req: http.IncomingMessage): boolean {
    if (!this.config.apiToken) return true;
    const authorization = headerValue(req.headers.authorization);
    if (!authorization?.startsWith("Bearer ")) return false;
    return secretEquals(authorization.slice(7), this.config.apiToken);
  }
}

export function loadHttpAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpAdapterConfig {
  const host = env.OMP_HTTP_HOST?.trim() || "0.0.0.0";
  const port = positiveInteger("OMP_HTTP_PORT", env.OMP_HTTP_PORT, 8765);
  const coreUrl = absoluteHttpUrl(
    "OMP_HTTP_CORE_URL",
    env.OMP_HTTP_CORE_URL?.trim() || "http://127.0.0.1:8787",
  ).replace(/\/$/, "");
  const maxBodyBytes = positiveInteger(
    "OMP_HTTP_MAX_BODY_BYTES",
    env.OMP_HTTP_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
  );
  const turnTimeoutMs = positiveInteger(
    "OMP_HTTP_TURN_TIMEOUT_MS",
    env.OMP_HTTP_TURN_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
  );
  const apiToken = env.OMP_HTTP_API_TOKEN || undefined;
  const agents = parseHttpRegistrations(env.OMP_ADAPTERS, env.OMP_AGENT_ID);
  return { host, port, coreUrl, maxBodyBytes, turnTimeoutMs, apiToken, agents };
}

function parseHttpRegistrations(
  raw: string | undefined,
  configuredAgentId: string | undefined,
): HttpAgentRegistration[] {
  if (!raw?.trim()) throw new Error("OMP_ADAPTERS is required");
  const agentId = configuredAgentId?.trim();
  if (!agentId) throw new Error("OMP_AGENT_ID is required");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `OMP_ADAPTERS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error("OMP_ADAPTERS must be an array");
  if (parsed.length !== 1) {
    throw new Error("OMP_ADAPTERS must contain exactly one adapter registration");
  }

  const value = parsed[0];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMP_ADAPTERS[0] must be an object");
  }
  const entry = value as Record<string, unknown>;
  for (const field of ["adapterId", "agentId", "sharedSecret", "callbackUrl"] as const) {
    if (typeof entry[field] !== "string" || !entry[field].trim()) {
      throw new Error(`OMP_ADAPTERS[0].${field} must be a non-empty string`);
    }
  }
  if (entry.agentId !== agentId) {
    throw new Error(
      `OMP_ADAPTERS[0].agentId "${entry.agentId}" does not match OMP_AGENT_ID "${agentId}"`,
    );
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(entry.callbackUrl as string);
  } catch {
    throw new Error("OMP_ADAPTERS[0].callbackUrl must be an absolute HTTP(S) URL");
  }
  if (callbackUrl.protocol !== "http:" && callbackUrl.protocol !== "https:") {
    throw new Error("OMP_ADAPTERS[0].callbackUrl must be an absolute HTTP(S) URL");
  }
  const callbackAgentId = matchCallbackRoute(callbackUrl.pathname);
  if (callbackAgentId === null) {
    throw new Error("OMP_ADAPTERS[0].callbackUrl must target /core/events/<agent-id>");
  }
  if (callbackAgentId !== agentId) {
    throw new Error(
      `HTTP callback agent "${callbackAgentId}" does not match registration agentId "${agentId}"`,
    );
  }

  return [{
    agentId,
    adapterId: entry.adapterId as string,
    sharedSecret: entry.sharedSecret as string,
  }];
}

function matchMessageRoute(
  path: string,
): { agentId: string; conversationKey: string } | null {
  const parts = path.split("/").filter(Boolean);
  if (
    parts.length !== 6 ||
    parts[0] !== "v1" ||
    parts[1] !== "agents" ||
    parts[3] !== "conversations" ||
    parts[5] !== "messages"
  ) {
    return null;
  }
  const agentId = decodePart(parts[2]);
  const conversationKey = decodePart(parts[4]);
  return agentId === null || conversationKey === null
    ? null
    : { agentId, conversationKey };
}

function matchCallbackRoute(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "core" || parts[1] !== "events") {
    return null;
  }
  return decodePart(parts[2]);
}

function parsePublicMessage(rawBody: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 ||
    typeof body.message !== "string" ||
    body.message.trim().length === 0
  ) {
    return null;
  }
  return body.message;
}

function parseOutboundEvent(rawBody: Buffer): OutboundEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const event = parsed as Record<string, unknown>;
  if (
    event.version !== ADAPTER_API_VERSION ||
    typeof event.type !== "string" ||
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.conversationKey !== "string" ||
    !event.conversationKey ||
    typeof event.correlationId !== "string" ||
    !event.correlationId ||
    !Number.isInteger(event.sequence) ||
    (event.sequence as number) < 1 ||
    typeof event.occurredAt !== "string"
  ) {
    return null;
  }
  switch (event.type) {
    case "turn.started":
      break;
    case "turn.progress":
      if (typeof event.message !== "string") return null;
      break;
    case "turn.reply":
      if (
        typeof event.text !== "string" ||
        !Array.isArray(event.attachments) ||
        event.usage === null ||
        typeof event.usage !== "object" ||
        Array.isArray(event.usage)
      ) {
        return null;
      }
      break;
    case "presence.changed":
      if (!["active", "idle", "offline"].includes(String(event.presence))) {
        return null;
      }
      break;
    case "turn.error":
      if (
        typeof event.code !== "string" ||
        typeof event.message !== "string" ||
        typeof event.retryable !== "boolean"
      ) {
        return null;
      }
      break;
    default:
      return null;
  }
  return event as unknown as OutboundEvent;
}

function verifySignature(signature: string, body: Buffer, secret: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (!match) return false;
  const actual = Buffer.from(match[1], "hex");
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function secretEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      req.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function absoluteHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return parsed.toString();
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const config = loadHttpAdapterConfig();
  const adapter = new HttpAgentAdapter(config);
  adapter.server.listen(config.port, config.host, () => {
    console.error(
      `>>> HTTP adapter listening on http://${config.host}:${config.port} for ${config.agents.length} agent(s)`,
    );
  });

  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      adapter.close().catch((error: unknown) => {
        console.error(
          ">>> HTTP adapter shutdown failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
      });
    });
  }
}
