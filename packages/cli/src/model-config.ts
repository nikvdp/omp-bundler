import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseYaml, stringifyYaml, YamlError } from "./config.ts";
import { resolveInside } from "./identifiers.ts";
import type { AgentDirectory, ProjectContext, YamlValue } from "./types.ts";

/** One schema-backed description of every model configuration field. */
/** Flags, wizard prompts, editor templates, parsing, validation, defaults, and help derive from this array. */
export interface ModelField {
  readonly key: string;
  readonly flag?: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  readonly default?: string;
  readonly defaultForAgent?: (agentId: string) => string;
  readonly choices?: readonly string[];
  readonly secret?: boolean;
}

export interface CliModelField extends ModelField {
  readonly flag: string;
}

export const MODEL_DIALECTS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
] as const;

export type ModelDialect = (typeof MODEL_DIALECTS)[number];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENV_TOKEN = /\$\{([^}]*)\}/g;

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

export const MODEL_FIELD_KEYS: readonly string[] = MODEL_FIELDS.map((field) => field.key);

export function resolveDefaultValue(field: ModelField, agentId: string): string | undefined {
  if (field.defaultForAgent) return field.defaultForAgent(agentId);
  return field.default;
}

export function modelConfigPath(project: ProjectContext, agentId: string): string {
  return resolveInside(project.rootDir, join("models", `${agentId}.yml`));
}

export function defaultApiKeyPlaceholder(agentId: string): string {
  const suffix = agentId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");
  return `\${OMP_MODEL_${suffix}_API_KEY}`;
}

function redactLiteralApiKey(apiKey: string | undefined, agentId: string): string {
  if (apiKey === undefined) return defaultApiKeyPlaceholder(agentId);
  if (apiKey === "" || isEnvTemplate(apiKey)) return apiKey;
  return defaultApiKeyPlaceholder(agentId);
}

function quoteYamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

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
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error(`${contextLabel}: baseUrl must be a non-empty string`);
  if (!isValidBaseUrl(baseUrl)) throw new Error(`${contextLabel}: baseUrl must be a URL or \${ENV_VAR} template`);

  const dialect = record.dialect;
  if (typeof dialect !== "string" || !MODEL_DIALECTS.includes(dialect as ModelDialect)) {
    throw new Error(`${contextLabel}: dialect must be one of: ${MODEL_DIALECTS.join(", ")}`);
  }

  const model = record.model;
  if (typeof model !== "string" || !model.trim()) throw new Error(`${contextLabel}: model must be a non-empty string`);
  if (placeholderShape(model) === undefined) throw new Error(`${contextLabel}: model contains a malformed environment placeholder`);

  const apiKey = record.apiKey;
  if (apiKey === undefined || apiKey === null) return { version: 1, baseUrl, dialect, model, apiKey: "" };
  if (typeof apiKey !== "string") throw new Error(`${contextLabel}: apiKey must be a string, empty, or \${ENV_VAR} template`);
  if (!isValidApiKey(apiKey)) throw new Error(`${contextLabel}: apiKey must be a literal, empty string, or \${ENV_VAR} template`);
  return { version: 1, baseUrl, dialect, model, apiKey };
}

function isValidBaseUrl(value: string): boolean {
  const shaped = placeholderShape(value);
  if (shaped === undefined) return false;
  if (isEnvTemplate(value)) return true;
  try {
    const url = new URL(shaped);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidApiKey(value: string): boolean {
  if (value === "") return true;
  return value.trim().length > 0 && placeholderShape(value) !== undefined;
}

function placeholderShape(value: string): string | undefined {
  if (!value.includes("${")) return value;
  let malformed = false;
  const shaped = value.replace(ENV_TOKEN, (_token, name: string) => {
    if (!ENV_NAME.test(name)) {
      malformed = true;
      return "";
    }
    return "placeholder";
  });
  return malformed || shaped.includes("${") ? undefined : shaped;
}

function isEnvTemplate(value: string): boolean {
  const match = value.match(/^\$\{([^}]*)\}$/);
  return match !== null && ENV_NAME.test(match[1]);
}

export interface ModelMetadata {
  readonly agentId: string;
  readonly dialect: string;
  readonly model: string;
  readonly envNames: readonly string[];
}

interface ValidatedModelConnection {
  readonly agentId: string;
  readonly providerId: string;
  readonly config: ModelConfig;
}

export interface LoadedModelBundle {
  readonly connections: readonly ValidatedModelConnection[];
  readonly metadata: readonly ModelMetadata[];
  readonly envNames: readonly string[];
}

function providerIdForAgent(agentId: string): string {
  return `omp-bundler-${agentId}`;
}

function placeholderNames(value: string, contextLabel: string): readonly string[] {
  const names: string[] = [];
  const remainder = value.replace(ENV_TOKEN, (_token, name: string) => {
    if (!ENV_NAME.test(name)) throw new Error(`${contextLabel}: contains a malformed environment placeholder`);
    names.push(name);
    return "";
  });
  if (remainder.includes("${")) throw new Error(`${contextLabel}: contains a malformed environment placeholder`);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export async function loadBundleModels(rootDir: string, agents: readonly AgentDirectory[]): Promise<LoadedModelBundle> {
  const modelsDir = resolveInside(rootDir, "models");
  const directory = await lstat(modelsDir).catch(() => null);
  if (!directory) {
    if (agents.length === 0) return { connections: [], metadata: [], envNames: [] };
    throw new Error(`${modelsDir}: model directory is missing`);
  }
  if (directory.isSymbolicLink()) throw new Error(`${modelsDir}: model directory must not be a symlink`);
  if (!directory.isDirectory()) throw new Error(`${modelsDir}: model path must be a directory`);

  const expected = new Set(agents.map((agent) => `${agent.id}.yml`));
  const entries = await readdir(modelsDir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(modelsDir, entry.name);
    if (!expected.has(entry.name)) throw new Error(`${path}: unknown model filename; expected one <agent-id>.yml per effective agent`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${path}: model file must not be a symlink`);
    if (!info.isFile()) throw new Error(`${path}: model file must be a regular file`);
  }
  for (const agent of agents) {
    const path = join(modelsDir, `${agent.id}.yml`);
    if (!await lstat(path).catch(() => null)) throw new Error(`${path}: model file is required for effective agent '${agent.id}'`);
  }

  const connections: ValidatedModelConnection[] = [];
  const metadata: ModelMetadata[] = [];
  const envNames = new Set<string>();
  for (const agent of [...agents].sort((left, right) => left.id.localeCompare(right.id))) {
    const path = join(modelsDir, `${agent.id}.yml`);
    const source = await readFile(path, "utf8").catch((error: unknown) => {
      throw new Error(`${path}: cannot read model file: ${error instanceof Error ? error.message : String(error)}`);
    });
    const config = parseModelConfig(source, path);
    const names = [...new Set([
      ...placeholderNames(config.baseUrl, `${path} [baseUrl]`),
      ...placeholderNames(config.model, `${path} [model]`),
      ...placeholderNames(config.apiKey, `${path} [apiKey]`),
    ])].sort((left, right) => left.localeCompare(right));
    for (const name of names) envNames.add(name);
    const providerId = providerIdForAgent(agent.id);
    connections.push({ agentId: agent.id, providerId, config });
    metadata.push({ agentId: agent.id, dialect: config.dialect, model: config.model, envNames: names });
  }
  return { connections, metadata, envNames: [...envNames].sort((left, right) => left.localeCompare(right)) };
}

export function renderModelCatalog(connections: readonly ValidatedModelConnection[]): string {
  const providers: Record<string, YamlValue> = {};
  for (const connection of [...connections].sort((left, right) => left.agentId.localeCompare(right.agentId))) {
    const provider: Record<string, YamlValue> = {
      baseUrl: connection.config.baseUrl,
      api: connection.config.dialect,
      models: [{ id: connection.config.model, name: connection.config.model }],
    };
    if (connection.config.apiKey === "") provider.auth = "none";
    else provider.apiKey = connection.config.apiKey;
    providers[connection.providerId] = provider;
  }
  return stringifyYaml({ providers });
}

interface YamlTextLine {
  readonly body: string;
  readonly ending: string;
}

function splitYamlLines(source: string): YamlTextLine[] {
  const lines: YamlTextLine[] = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
    if (end === source.length) {
      lines.push({ body: source.slice(start), ending: "" });
      break;
    }
    const ending = source[end] === "\r" && source[end + 1] === "\n" ? "\r\n" : source[end];
    lines.push({ body: source.slice(start, end), ending });
    start = end + ending.length;
  }
  return lines;
}

function joinYamlLines(lines: readonly YamlTextLine[]): string {
  return lines.map((line) => `${line.body}${line.ending}`).join("");
}

function yamlKey(value: string): string | undefined {
  if (value.trimStart().startsWith("#")) return undefined;
  return value.match(/^\s*([^:#][^:]*)\s*:/)?.[1].trim();
}

function indentOf(value: string): number {
  return value.length - value.trimStart().length;
}

function yamlLineEnding(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function quoteStagedModel(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

export function stageAgentModelBinding(source: string, providerId: string, model: string, contextLabel: string): string {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${contextLabel}: ${error.message}`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${contextLabel}: expected a YAML mapping`);
  if (parsed.modelRoles !== undefined && !isRecord(parsed.modelRoles)) {
    throw new Error(`${contextLabel}: modelRoles must be a block mapping to stage model default`);
  }
  const lines = splitYamlLines(source);
  const rolesLine = lines.findIndex((line) => indentOf(line.body) === 0 && yamlKey(line.body) === "modelRoles");
  const binding = `default: ${quoteStagedModel(`${providerId}/${model}`)}`;
  const ending = yamlLineEnding(source);
  if (rolesLine < 0) {
    return `${source}${source.endsWith("\n") || source.endsWith("\r") ? "" : ending}modelRoles:${ending}  ${binding}${ending}`;
  }
  if (lines[rolesLine].body.slice(lines[rolesLine].body.indexOf(":") + 1).trim()) {
    throw new Error(`${contextLabel}: modelRoles must be a block mapping to stage model default`);
  }
  const parentIndent = indentOf(lines[rolesLine].body);
  let childIndent: number | undefined;
  let defaultLine = -1;
  let end = lines.length;
  for (let index = rolesLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.body.trim();
    const indent = indentOf(line.body);
    if (trimmed && !trimmed.startsWith("#") && indent <= parentIndent) {
      end = index;
      break;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    childIndent ??= indent;
    if (indent === childIndent && yamlKey(line.body) === "default") defaultLine = index;
  }
  childIndent ??= parentIndent + 2;
  if (defaultLine >= 0) {
    const colon = lines[defaultLine].body.indexOf(":");
    const original = lines[defaultLine].body.slice(colon + 1);
    const comment = original.match(/(\s+#.*)$/)?.[1] ?? "";
    lines[defaultLine] = { body: `${" ".repeat(childIndent)}${binding}${comment}`, ending: lines[defaultLine].ending };
  } else {
    const inserted = { body: `${" ".repeat(childIndent)}${binding}`, ending };
    if (end === lines.length && lines.length > 0 && lines[lines.length - 1].ending === "") {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = { body: last.body, ending };
      lines.push(inserted);
    } else {
      lines.splice(end, 0, inserted);
    }
  }
  return joinYamlLines(lines);
}

export function expandModelPlaceholders(value: string, env: ReadonlyMap<string, string>, contextLabel: string): string {
  const shaped = placeholderShape(value);
  if (shaped === undefined) throw new Error(`${contextLabel}: contains a malformed environment placeholder`);
  return value.replace(ENV_TOKEN, (_token, name: string) => env.get(name) ?? _token);
}

export function validateExpandedBaseUrl(value: string, contextLabel: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error(`${contextLabel}: must resolve to an absolute HTTP(S) URL`);
  }
}
