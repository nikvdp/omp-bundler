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
  manifestName: string;
  manifestDisplayName: string;
  manifestBotTitle: string;
  signatureToleranceSeconds: number;
  /** Base URL of the omp-bundler core inbound endpoint (no trailing slash). */
  coreUrl: string;
  /** Adapter id under which this adapter registers with core (route-scoped). */
  coreAdapterId: string;
  /** Shared secret for inbound auth header and outbound HMAC verification. */
  coreSharedSecret: string;
  /** Maximum bytes accepted on the /pumble/events inbound webhook body. */
  pumbleEventMaxBytes: number;
  /** Maximum bytes accepted on the /core/events outbound callback body. */
  coreEventMaxBytes: number;
  /** Seconds before a signed download link expires. */
  downloadLinkTtlSeconds: number;
  /** Timeout applied to every Pumble and core HTTP request. */
  httpTimeoutMs: number;
  /** Maximum bytes served on a single GET /download response. */
  downloadMaxBytes: number;
  /**
   * Path of the runtime-mutable settings file. Behavior knobs live there
   * rather than in env so the agent can change them while running; see
   * settings.ts.
   */
  settingsFile: string;
}

export function loadBridgeConfig(env = process.env): BridgeConfig {
  const dataDir = valueOrDefault(
    env.PUMBLE_BRIDGE_DATA_DIR,
    "/data",
    "PUMBLE_BRIDGE_DATA_DIR",
  );
  return {
    host: valueOrDefault(
      env.PUMBLE_BRIDGE_HOST,
      "0.0.0.0",
      "PUMBLE_BRIDGE_HOST",
    ),
    port: positiveNumberEnv("PUMBLE_BRIDGE_PORT", env.PUMBLE_BRIDGE_PORT, 8765),
    dataDir,
    pumbleDataDir: valueOrDefault(
      env.PUMBLE_BRIDGE_PUMBLE_DATA_DIR,
      path.join(dataDir, "pumble"),
      "PUMBLE_BRIDGE_PUMBLE_DATA_DIR",
    ),
    pumbleFileDir: valueOrDefault(
      env.PUMBLE_BRIDGE_FILE_DIR,
      path.join(dataDir, "workspace", "pumble-files"),
      "PUMBLE_BRIDGE_FILE_DIR",
    ),
    pumbleFileHostBaseUrl: valueOrDefault(
      env.PUMBLE_FILE_HOST_BASE_URL,
      "https://files.pumble.com",
      "PUMBLE_FILE_HOST_BASE_URL",
    ).replace(/\/$/, ""),
    pumbleFileMaxBytes: positiveNumberEnv(
      "PUMBLE_FILE_MAX_BYTES",
      env.PUMBLE_FILE_MAX_BYTES,
      512 * 1024 * 1024,
    ),
    publicBaseUrl: publicBaseUrlEnv(env.PUMBLE_PUBLIC_BASE_URL),
    appId: requiredEnv(env.PUMBLE_APP_ID, "PUMBLE_APP_ID"),
    clientSecret: requiredEnv(
      env.PUMBLE_APP_CLIENT_SECRET,
      "PUMBLE_APP_CLIENT_SECRET",
    ),
    appKey: requiredEnv(env.PUMBLE_APP_KEY, "PUMBLE_APP_KEY"),
    signingSecret: requiredEnv(
      env.PUMBLE_APP_SIGNING_SECRET,
      "PUMBLE_APP_SIGNING_SECRET",
    ),
    workspaceId: env.PUMBLE_WORKSPACE_ID?.trim() ?? "",
    workspaceUserId: env.PUMBLE_WORKSPACE_USER_ID?.trim() ?? "",
    pumbleApiBaseUrl: valueOrDefault(
      env.PUMBLE_API_BASE_URL,
      "https://api-ga.pumble.com",
      "PUMBLE_API_BASE_URL",
    ).replace(/\/$/, ""),
    manifestName: valueOrDefault(
      env.PUMBLE_MANIFEST_NAME,
      "omp_bundler_pumble",
      "PUMBLE_MANIFEST_NAME",
    ),
    manifestDisplayName: valueOrDefault(
      env.PUMBLE_MANIFEST_DISPLAY_NAME,
      "OMP Bundler",
      "PUMBLE_MANIFEST_DISPLAY_NAME",
    ),
    manifestBotTitle: valueOrDefault(
      env.PUMBLE_MANIFEST_BOT_TITLE,
      "OMP Bundler Agent",
      "PUMBLE_MANIFEST_BOT_TITLE",
    ),
    signatureToleranceSeconds: positiveNumberEnv(
      "PUMBLE_SIGNATURE_TOLERANCE_SECONDS",
      env.PUMBLE_SIGNATURE_TOLERANCE_SECONDS,
      300,
    ),
    coreUrl: requiredEnv(env.PUMBLE_CORE_URL, "PUMBLE_CORE_URL").replace(
      /\/$/,
      "",
    ),
    coreAdapterId: valueOrDefault(
      env.PUMBLE_ADAPTER_ID,
      "pumble",
      "PUMBLE_ADAPTER_ID",
    ),
    coreSharedSecret: requiredEnv(
      env.PUMBLE_CORE_SHARED_SECRET,
      "PUMBLE_CORE_SHARED_SECRET",
    ),
    pumbleEventMaxBytes: positiveNumberEnv(
      "PUMBLE_EVENT_MAX_BYTES",
      env.PUMBLE_EVENT_MAX_BYTES,
      2 * 1024 * 1024,
    ),
    coreEventMaxBytes: positiveNumberEnv(
      "PUMBLE_CORE_EVENT_MAX_BYTES",
      env.PUMBLE_CORE_EVENT_MAX_BYTES,
      2 * 1024 * 1024,
    ),
    downloadLinkTtlSeconds: positiveNumberEnv(
      "PUMBLE_DOWNLOAD_LINK_TTL_SECONDS",
      env.PUMBLE_DOWNLOAD_LINK_TTL_SECONDS,
      3600,
    ),
    downloadMaxBytes: positiveNumberEnv(
      "PUMBLE_DOWNLOAD_MAX_BYTES",
      env.PUMBLE_DOWNLOAD_MAX_BYTES,
      512 * 1024 * 1024,
    ),
    httpTimeoutMs: positiveNumberEnv(
      "PUMBLE_HTTP_TIMEOUT_MS",
      env.PUMBLE_HTTP_TIMEOUT_MS,
      15_000,
    ),
    // Behavior knobs are not env-configurable: they live in a JSONC file on
    // the durable volume so the agent can change them while running.
    settingsFile: valueOrDefault(
      env.PUMBLE_SETTINGS_FILE,
      path.join(dataDir, "config", "settings.jsonc"),
      "PUMBLE_SETTINGS_FILE",
    ),
  };
}

function positiveNumberEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

function publicBaseUrlEnv(value: string | undefined): string {
  const raw = requiredEnv(value, "PUMBLE_PUBLIC_BASE_URL").replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUMBLE_PUBLIC_BASE_URL must be an absolute URL");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PUMBLE_PUBLIC_BASE_URL must use HTTPS outside localhost");
  }
  return raw;
}

function requiredEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function valueOrDefault(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

export function joinPublicUrl(config: BridgeConfig, route: string) {
  if (!config.publicBaseUrl) {
    return route;
  }
  return `${config.publicBaseUrl}${route.startsWith("/") ? route : `/${route}`}`;
}
