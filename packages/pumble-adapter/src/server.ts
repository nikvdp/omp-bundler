import http from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import { buildManifest } from "./manifest.js";
import { PumbleApi } from "./pumble-api.js";
import { verifyPumbleSignature } from "./security.js";
import { TokenStore } from "./token-store.js";

const config = loadBridgeConfig();
await mkdir(config.pumbleDataDir, { recursive: true });

const pumble = new PumbleApi(config);
const tokens = new TokenStore(path.join(config.pumbleDataDir, "workspaces.json"));

const server = http.createServer(async (req, res) => {
  try {
    await route(config, req, res);
  } catch (error) {
    console.warn(">>> Pumble adapter request failed:", error instanceof Error ? error.message : error);
    sendText(res, 500, "internal error");
  }
});

server.listen(config.port, config.host, () => {
  console.log(`>>> Pumble adapter listening on http://${config.host}:${config.port}`);
});

async function route(config: BridgeConfig, req: http.IncomingMessage, res: http.ServerResponse) {
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
    await handleEvents(req, res);
    return;
  }

  sendText(res, 404, "not found");
}

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
    console.warn(">>> Pumble OAuth exchange failed:", error instanceof Error ? error.message : error);
    sendText(res, 401, "Could not authorize Pumble app.");
  }
}

async function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  const rawBody = await readBody(req);
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
  if (
    workspaceId &&
    (eventType === "APP_UNAUTHORIZED" || eventType === "APP_UNINSTALLED")
  ) {
    await tokens.deleteWorkspace(workspaceId);
  }

  sendText(res, 200, "ok");
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
