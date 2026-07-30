/**
 * Validated configuration for the omp-bundler core supervisor.
 *
 * All values are sourced once from the process environment at
 * {@link loadCoreConfig} time and validated loudly: there are no hidden
 * operational defaults for production addresses, ports, paths, or
 * credentials. Defaults exist only for true application invariants
 * (e.g. the SQLite journal mode) never for operator-supplied wiring.
 *
 * Secret boundary: adapter shared secrets are carried inside the
 * declarative adapter registrations JSON and never appear as individual
 * env vars. The config object never logs secrets; {@link safeDescribe}
 * produces a diagnostic snapshot with secrets redacted.
 */
import { randomUUID } from "node:crypto";
import type { AdapterRegistration } from "./adapter-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Declarative adapter registration as it appears in the JSON env var. */
export interface AdapterConfigEntry {
  adapterId: string;
  callbackUrl: string;
  sharedSecret: string;
  /** Optional agent id; must reference a declared agent in `agents`. */
  agentId?: string;
}

/** Declarative agent identity as it appears in the OMP_AGENTS JSON env var. */
export interface AgentConfigEntry {
  /** Agent id matching /^[a-z0-9][a-z0-9_-]{0,63}$/; unique across entries. */
  agentId: string;
  /** Pinned model id, or null when not pinned. */
  model: string | null;
  /** Extra args appended after the agent's model on child spawn. */
  args: string[];
}

/** Validated, immutable supervisor configuration. */
export interface CoreConfig {
  /** Bind host for the HTTP service. No default; operator must supply. */
  host: string;
  /** Bind port for the HTTP service. No default; operator must supply. */
  port: number;
  /** Filesystem path to the session registry SQLite database. */
  sessionDbPath: string;
  /** Filesystem path to the idempotency store SQLite database. */
  idempotencyDbPath: string;
  /** Filesystem path to the outbound emitter outbox SQLite database. */
  outboxDbPath: string;
  /** Filesystem path to the persistent child process-group registry. */
  childRegistryPath: string;
  /** Workspace directory (OMP cwd) for child processes. */
  workspaceDir: string;
  /** OMP binary to spawn. Defaults to "omp". */
  ompBinary: string;
  /** OMP model id, or null when not pinned. */
  ompModel: string | null;
  /** OMP profile name, or null when not pinned. */
  ompProfile: string | null;
  /** Extra args appended after --mode rpc on every child spawn. */
  ompArgs: string[];
  /** Maximum number of concurrent child processes. */
  maxChildren: number;
  /** Idle timeout in ms before a child is swept from the pool. */
  idleTimeoutMs: number;
  /** Engagement window length in ms for the ingest buffer. */
  engagementWindowMs: number;
  /** Timeout in ms for outbound callback HTTP POSTs. */
  callbackTimeoutMs: number;
  /** Minimum gap in ms between best-effort progress events. */
  progressThresholdMs: number;
  /** Ordered retry delays (ms) for durable outbound delivery. */
  retryDelaysMs: number[];
  /** Declarative adapter registrations. */
  adapters: AdapterRegistration[];
  /** Declarative agent identities (OMP_AGENTS), empty when unset. */
  agents: AgentConfigEntry[];
  /** Root directory holding per-agent workspaces (OMP_AGENTS_ROOT), null when unset. */
  agentsRootDir: string | null;
}

// ---------------------------------------------------------------------------
// Env source
// ---------------------------------------------------------------------------

export interface CoreConfigEnv {
  [key: string]: string | undefined;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the core supervisor configuration from `env`
 * (defaults to `process.env`). Throws on any missing/invalid value; never
 * returns a partial config. Secrets are never logged.
 */
export function loadCoreConfig(env: CoreConfigEnv = process.env): CoreConfig {
  const host = required(env, "OMP_HOST");
  const port = requiredInt(env, "OMP_PORT");
  const sessionDbPath = required(env, "OMP_SESSION_DB_PATH");
  const idempotencyDbPath = required(env, "OMP_IDEMPOTENCY_DB_PATH");
  const outboxDbPath = required(env, "OMP_OUTBOX_DB_PATH");
  const childRegistryPath = required(env, "OMP_CHILD_REGISTRY_PATH");
  const workspaceDir = required(env, "OMP_WORKSPACE_DIR");

  const ompBinary = env.OMP_BINARY?.trim() || "omp";
  const ompModel = env.OMP_MODEL?.trim() || null;
  const ompProfile = env.OMP_PROFILE?.trim() || null;
  const ompArgs = parseArgs(env.OMP_ARGS);

  const maxChildren = requiredInt(env, "OMP_MAX_CHILDREN");
  const idleTimeoutMs = requiredInt(env, "OMP_IDLE_TIMEOUT_MS");
  const engagementWindowMs = requiredInt(env, "OMP_ENGAGEMENT_WINDOW_MS");
  const callbackTimeoutMs = requiredInt(env, "OMP_CALLBACK_TIMEOUT_MS");
  const progressThresholdMs = optionalInt(
    env,
    "OMP_PROGRESS_THRESHOLD_MS",
    500,
  );
  const retryDelaysMs = parseRetryDelays(env.OMP_RETRY_DELAYS_MS);

  const agents = parseAgents(env.OMP_AGENTS);
  const knownAgentIds = new Set(agents.map((a) => a.agentId));
  const adapters = parseAdapters(env.OMP_ADAPTERS, knownAgentIds);

  const agentsRootDir = env.OMP_AGENTS_ROOT?.trim() || null;
  if (agents.length > 0 && agentsRootDir === null) {
    throw new Error(
      "OMP_AGENTS_ROOT is required when OMP_AGENTS is non-empty",
    );
  }

  return {
    host,
    port,
    sessionDbPath,
    idempotencyDbPath,
    outboxDbPath,
    childRegistryPath,
    workspaceDir,
    ompBinary,
    ompModel,
    ompProfile,
    ompArgs,
    maxChildren,
    idleTimeoutMs,
    engagementWindowMs,
    callbackTimeoutMs,
    progressThresholdMs,
    retryDelaysMs,
    adapters,
    agents,
    agentsRootDir,
  };
}

// ---------------------------------------------------------------------------
// Safe description (no secrets)
// ---------------------------------------------------------------------------

/**
 * Return a diagnostic snapshot of the config with all secrets redacted.
 * Safe to log. Adapter entries are reduced to id + callback URL only.
 */
export function safeDescribe(config: CoreConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    sessionDbPath: config.sessionDbPath,
    idempotencyDbPath: config.idempotencyDbPath,
    outboxDbPath: config.outboxDbPath,
    childRegistryPath: config.childRegistryPath,
    workspaceDir: config.workspaceDir,
    ompBinary: config.ompBinary,
    ompModel: config.ompModel,
    ompProfile: config.ompProfile,
    ompArgs: config.ompArgs,
    maxChildren: config.maxChildren,
    idleTimeoutMs: config.idleTimeoutMs,
    engagementWindowMs: config.engagementWindowMs,
    callbackTimeoutMs: config.callbackTimeoutMs,
    progressThresholdMs: config.progressThresholdMs,
    retryDelaysMs: config.retryDelaysMs,
    adapters: config.adapters.map((a) => ({
      adapterId: a.adapterId,
      callbackUrl: a.callbackUrl,
      agentId: a.agentId ?? null,
    })),
    agents: config.agents.map((a) => a.agentId),
    agentsRootDir: config.agentsRootDir,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Agent id validation regex: lowercase alphanumerics, underscores, hyphens;
 * must start with a letter or digit; 1-64 chars total.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function required(env: CoreConfigEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) {
    throw new Error(`missing required environment variable: ${key}`);
  }
  return v;
}

function requiredInt(env: CoreConfigEnv, key: string): number {
  const raw = required(env, key);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function optionalInt(
  env: CoreConfigEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${key} must be a nonnegative integer, got: ${raw}`);
  }
  return n;
}

/**
 * Parse a whitespace-or-comma-separated arg list. Empty/undefined yields [].
 * Example: "--verbose --foo bar" -> ["--verbose", "--foo", "bar"]
 */
function parseArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  return trimmed.split(/[\s,]+/).filter((s) => s.length > 0);
}

/**
 * Parse the retry delay schedule: comma-separated nonnegative integers.
 * Empty/undefined yields an empty schedule (no retries).
 */
function parseRetryDelays(raw: string | undefined): number[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `OMP_RETRY_DELAYS_MS entries must be nonnegative numbers, got: ${p}`,
      );
    }
    result.push(Math.floor(n));
  }
  return result;
}

/**
 * Parse the declarative adapter registrations from a JSON env var.
 * The JSON must be an array of {adapterId, callbackUrl, sharedSecret, agentId?}.
 * Secrets are validated for non-emptiness but never logged. When an entry has
 * `agentId`, it must match the agent id regex and reference a declared agent in
 * `knownAgentIds`, else an Error naming OMP_ADAPTERS and the unknown id is
 * thrown.
 */
function parseAdapters(
  raw: string | undefined,
  knownAgentIds: Set<string>,
): AdapterRegistration[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      "missing required environment variable: OMP_ADAPTERS (JSON array)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `OMP_ADAPTERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "OMP_ADAPTERS must be a JSON array of adapter registrations",
    );
  }
  const entries: AdapterRegistration[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`OMP_ADAPTERS[${i}] must be an object`);
    }
    const r = entry as Record<string, unknown>;
    const adapterId = strField(r, "adapterId", i);
    const callbackUrl = strField(r, "callbackUrl", i);
    const sharedSecret = strField(r, "sharedSecret", i);
    const registration: AdapterRegistration = {
      adapterId,
      callbackUrl,
      sharedSecret,
    };
    if (r.agentId !== undefined) {
      const agentId = r.agentId;
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error(
          `OMP_ADAPTERS[${i}].agentId must be a non-empty string`,
        );
      }
      if (!AGENT_ID_RE.test(agentId)) {
        throw new Error(
          `OMP_ADAPTERS[${i}].agentId "${agentId}" must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
        );
      }
      if (!knownAgentIds.has(agentId)) {
        throw new Error(
          `OMP_ADAPTERS[${i}].agentId "${agentId}" does not match any declared OMP_AGENTS entry`,
        );
      }
      registration.agentId = agentId;
    }
    entries.push(registration);
  }
  return entries;
}

function strField(
  obj: Record<string, unknown>,
  name: string,
  index: number,
): string {
  const v = obj[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `OMP_ADAPTERS[${index}].${name} must be a non-empty string`,
    );
  }
  return v;
}

/**
 * Parse the declarative agent identities from the OMP_AGENTS JSON env var.
 * The JSON must be an array of {agentId, model?, args?}. agentId is required
 * and must match {@link AGENT_ID_RE}; duplicate agentIds are rejected. model
 * is an optional string (trimmed; empty/absent becomes null). args is an
 * optional array of non-empty strings (absent becomes []). Returns [] when
 * OMP_AGENTS is unset or empty.
 */
function parseAgents(raw: string | undefined): AgentConfigEntry[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `OMP_AGENTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OMP_AGENTS must be a JSON array of agent declarations");
  }
  const entries: AgentConfigEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`OMP_AGENTS[${i}] must be an object`);
    }
    const r = entry as Record<string, unknown>;
    const agentId = r.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error(
        `OMP_AGENTS[${i}].agentId must be a non-empty string`,
      );
    }
    if (!AGENT_ID_RE.test(agentId)) {
      throw new Error(
        `OMP_AGENTS[${i}].agentId "${agentId}" must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
      );
    }
    if (seen.has(agentId)) {
      throw new Error(`OMP_AGENTS[${i}].agentId "${agentId}" is a duplicate`);
    }
    seen.add(agentId);

    let model: string | null = null;
    if (r.model !== undefined) {
      if (typeof r.model !== "string") {
        throw new Error(`OMP_AGENTS[${i}].model must be a string`);
      }
      const trimmedModel = r.model.trim();
      model = trimmedModel.length > 0 ? trimmedModel : null;
    }

    let args: string[] = [];
    if (r.args !== undefined) {
      if (!Array.isArray(r.args)) {
        throw new Error(`OMP_AGENTS[${i}].args must be an array of strings`);
      }
      for (let j = 0; j < r.args.length; j++) {
        const a = r.args[j];
        if (typeof a !== "string" || a.length === 0) {
          throw new Error(
            `OMP_AGENTS[${i}].args[${j}] must be a non-empty string`,
          );
        }
      }
      args = r.args as string[];
    }

    entries.push({ agentId, model, args });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Test helpers (not for production use)
// ---------------------------------------------------------------------------

/**
 * Build a config for tests with injected overrides. All required fields
 * get safe test defaults; secrets are random UUIDs so they are never real.
 */
export function testConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  const base: CoreConfig = {
    host: "127.0.0.1",
    port: 0,
    sessionDbPath: ":memory:",
    idempotencyDbPath: ":memory:",
    outboxDbPath: ":memory:",
    childRegistryPath: "",
    workspaceDir: "/tmp",
    ompBinary: "omp",
    ompModel: null,
    ompProfile: null,
    ompArgs: [],
    maxChildren: 2,
    idleTimeoutMs: 5000,
    engagementWindowMs: 5000,
    callbackTimeoutMs: 5000,
    progressThresholdMs: 100,
    retryDelaysMs: [],
    adapters: [
      {
        adapterId: "test-adapter",
        callbackUrl: "http://localhost:0/callback",
        sharedSecret: randomUUID(),
      },
    ],
    agents: [],
    agentsRootDir: null,
  };
  return { ...base, ...overrides };
}
