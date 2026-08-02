import { join } from "node:path";
import { parseYaml, YamlError } from "./config.ts";
import { resolveInside } from "./identifiers.ts";
import type { ProjectContext, YamlValue } from "./types.ts";

/**
 * One schema-backed description of every model configuration field.
 * Flags, wizard prompts, editor templates, parsing, validation, defaults,
 * and help details all derive from this array so the interfaces cannot drift.
 */
export interface ModelField {
  readonly key: string;
  readonly flag?: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  readonly default?: string;
  /** When set, the default value is derived from the agent id at call time. */
  readonly defaultForAgent?: (agentId: string) => string;
  readonly choices?: readonly string[];
  readonly secret?: boolean;
}

/** A model field that has a CLI flag (excludes version). */
export interface CliModelField extends ModelField {
  readonly flag: string;
}

export const MODEL_DIALECTS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
] as const;

export type ModelDialect = (typeof MODEL_DIALECTS)[number];

export const MODEL_FIELDS: readonly ModelField[] = [
  {
    key: "version",
    label: "Version",
    description: "Schema version; must be 1.",
    required: true,
    default: "1",
  },
  {
    key: "baseUrl",
    flag: "base-url",
    label: "Base URL",
    description: "Provider API base URL, e.g. https://api.openai.com/v1. Use ${ENV_VAR} for templated values.",
    required: true,
  },
  {
    key: "dialect",
    flag: "dialect",
    label: "API dialect",
    description: "Protocol dialect the provider speaks.",
    required: true,
    choices: MODEL_DIALECTS,
  },
  {
    key: "model",
    flag: "model",
    label: "Model name",
    description: "Provider model identifier, e.g. gpt-5.4 or claude-sonnet-5.",
    required: true,
  },
  {
    key: "apiKey",
    flag: "api-key",
    label: "API key",
    description: "Literal key, empty string for no-auth, or ${ENV_VAR} template. Redacted from output.",
    required: false,
    defaultForAgent: defaultApiKeyPlaceholder,
    secret: true,
  },
] as const;

export interface ModelConfig {
  readonly version: number;
  readonly baseUrl: string;
  readonly dialect: string;
  readonly model: string;
  readonly apiKey: string;
}

/** Set of valid YAML keys derived from MODEL_FIELDS. */
export const MODEL_FIELD_KEYS: readonly string[] = MODEL_FIELDS.map((field) => field.key);

/** Resolve the default value for a field, using the agent-aware default when set. */
export function resolveDefaultValue(field: ModelField, agentId: string): string | undefined {
  if (field.defaultForAgent) return field.defaultForAgent(agentId);
  return field.default;
}

/** Path to the user-authored model file at the bundle root. */
export function modelConfigPath(project: ProjectContext, agentId: string): string {
  return resolveInside(project.rootDir, join("models", `${agentId}.yml`));
}

/** Derive the default env-placeholder API key for an agent. */
export function defaultApiKeyPlaceholder(agentId: string): string {
  const suffix = agentId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");
  return `\${OMP_MODEL_${suffix}_API_KEY}`;
}

/** Replace a literal API key with the agent's env placeholder; keep templates and empty values. */
function redactLiteralApiKey(apiKey: string | undefined, agentId: string): string {
  if (apiKey === undefined) return defaultApiKeyPlaceholder(agentId);
  if (apiKey === "" || isEnvTemplate(apiKey)) return apiKey;
  return defaultApiKeyPlaceholder(agentId);
}

/** Quote a YAML scalar value safely for user-facing output. */
function quoteYamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Render the canonical commented template. Used by editor mode (initial
 * content when no config exists) and --print-template. Active fields are
 * uncommented; the API key defaults to an env placeholder so it is never
 * literal in generated output.
 */
export function renderModelTemplate(agentId: string, existing?: ModelConfig): string {
  const values: Record<string, string> = {
    version: "1",
    baseUrl: existing?.baseUrl ?? "",
    dialect: existing?.dialect ?? "",
    model: existing?.model ?? "",
    apiKey: redactLiteralApiKey(existing?.apiKey, agentId),
  };
  const lines: string[] = [
    `# Model configuration for agent '${agentId}'.`,
    `# Edit directly or regenerate with: omp-bundler set-model ${agentId}`,
    `# Accept literal values or \${ENV_VAR} templates for baseUrl and apiKey.`,
    `# An empty quoted apiKey ("") means no authentication.`,
    "",
  ];
  for (const field of MODEL_FIELDS) {
    if (field.key === "version") {
      lines.push(`version: ${values.version}`);
      lines.push("");
      continue;
    }
    if (field.description) lines.push(`# ${field.description}`);
    if (field.choices) lines.push(`# Choices: ${field.choices.join(", ")}`);
    const raw = values[field.key];
    if (field.key === "apiKey" && raw === "" && existing !== undefined) {
      lines.push(`${field.key}: ""`);
    } else if (raw) {
      lines.push(`${field.key}: ${quoteYamlScalar(raw)}`);
    } else {
      lines.push(`# ${field.key}: ${field.key === "apiKey" ? '""' : "<value>"}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

interface ParsedModel {
  readonly version: unknown;
  readonly baseUrl: unknown;
  readonly dialect: unknown;
  readonly model: unknown;
  readonly apiKey: unknown;
  readonly [key: string]: unknown;
}

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse and validate a model config source, returning typed config or throwing. */
export function parseModelConfig(source: string, contextLabel: string): ModelConfig {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${contextLabel}: ${error.message}`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${contextLabel}: expected a YAML mapping`);
  const record = parsed as ParsedModel;
  for (const key of Object.keys(parsed)) {
    if (!MODEL_FIELD_KEYS.includes(key)) {
      throw new Error(`${contextLabel}: unknown key '${key}'; valid keys are: ${MODEL_FIELD_KEYS.join(", ")}`);
    }
  }

  if (record.version !== 1) throw new Error(`${contextLabel}: version must be 1`);

  const baseUrl = record.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error(`${contextLabel}: baseUrl must be a non-empty string`);
  }
  if (!isValidBaseUrl(baseUrl)) {
    throw new Error(`${contextLabel}: baseUrl must be a URL or \${ENV_VAR} template`);
  }

  const dialect = record.dialect;
  if (typeof dialect !== "string" || !MODEL_DIALECTS.includes(dialect as ModelDialect)) {
    throw new Error(`${contextLabel}: dialect must be one of: ${MODEL_DIALECTS.join(", ")}`);
  }

  const model = record.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`${contextLabel}: model must be a non-empty string`);
  }

  const apiKey = record.apiKey;
  if (apiKey === undefined || apiKey === null) {
    return { version: 1, baseUrl, dialect, model, apiKey: "" };
  }
  if (typeof apiKey !== "string") {
    throw new Error(`${contextLabel}: apiKey must be a string, empty, or \${ENV_VAR} template`);
  }
  if (!isValidApiKey(apiKey)) {
    throw new Error(`${contextLabel}: apiKey must be a literal, empty string, or \${ENV_VAR} template`);
  }
  return { version: 1, baseUrl, dialect, model, apiKey };
}

function isValidBaseUrl(value: string): boolean {
  if (isEnvTemplate(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidApiKey(value: string): boolean {
  if (value === "") return true;
  if (isEnvTemplate(value)) return true;
  return value.trim().length > 0;
}

function isEnvTemplate(value: string): boolean {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

