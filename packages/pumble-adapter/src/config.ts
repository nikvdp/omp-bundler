import path from "node:path";

export interface BridgeConfig {
  host: string;
  port: number;
  dataDir: string;
  pumbleDataDir: string;
  pumbleFileDir: string;
  pumbleFileHostBaseUrl: string;
  pumbleFileMaxBytes: number;
  publicBaseUrl: string;
  appId: string;
  clientSecret: string;
  appKey: string;
  signingSecret: string;
  workspaceId: string;
  workspaceUserId: string;
  pumbleApiBaseUrl: string;
  agentAgentUrl: string;
  manifestName: string;
  manifestDisplayName: string;
  manifestBotTitle: string;
  signatureToleranceSeconds: number;
}

export function loadBridgeConfig(env = process.env): BridgeConfig {
  const dataDir = env.PUMBLE_BRIDGE_DATA_DIR || "/data";
  return {
    host: env.PUMBLE_BRIDGE_HOST || "0.0.0.0",
    port: numberEnv(env.PUMBLE_BRIDGE_PORT, 8765),
    dataDir,
    pumbleDataDir: env.PUMBLE_BRIDGE_PUMBLE_DATA_DIR || path.join(dataDir, "pumble"),
    pumbleFileDir:
      env.PUMBLE_BRIDGE_FILE_DIR || path.join(dataDir, "workspace", "pumble-files"),
    pumbleFileHostBaseUrl: (env.PUMBLE_FILE_HOST_BASE_URL || "https://files.pumble.com").replace(
      /\/$/,
      "",
    ),
    pumbleFileMaxBytes: numberEnv(env.PUMBLE_FILE_MAX_BYTES, 512 * 1024 * 1024),
    publicBaseUrl: (env.PUMBLE_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    appId: env.PUMBLE_APP_ID || "",
    clientSecret: env.PUMBLE_APP_CLIENT_SECRET || env.PUMBLE_CLIENT_SECRET || "",
    appKey: env.PUMBLE_APP_KEY || "",
    signingSecret: env.PUMBLE_APP_SIGNING_SECRET || env.PUMBLE_SIGNING_SECRET || "",
    workspaceId: env.PUMBLE_WORKSPACE_ID || "",
    workspaceUserId: env.PUMBLE_WORKSPACE_USER_ID || "",
    pumbleApiBaseUrl: (env.PUMBLE_API_BASE_URL || "https://api-ga.pumble.com").replace(
      /\/$/,
      "",
    ),
    agentAgentUrl: (env.PUMBLE_agent_AGENT_URL || "http://agent-service:3583").replace(
      /\/$/,
      "",
    ),
    manifestName: env.PUMBLE_MANIFEST_NAME || "omp_bundler_pumble",
    manifestDisplayName: env.PUMBLE_MANIFEST_DISPLAY_NAME || "agent",
    manifestBotTitle: env.PUMBLE_MANIFEST_BOT_TITLE || "OMP Bundler Agent",
    signatureToleranceSeconds: numberEnv(env.PUMBLE_SIGNATURE_TOLERANCE_SECONDS, 300),
  };
}

function numberEnv(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function joinPublicUrl(config: BridgeConfig, route: string) {
  if (!config.publicBaseUrl) {
    return route;
  }
  return `${config.publicBaseUrl}${route.startsWith("/") ? route : `/${route}`}`;
}
