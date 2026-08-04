import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseYaml, stringifyYaml, YamlError } from "./config.ts";
import { resolveInside } from "./identifiers.ts";
import type { AgentDirectory, ProjectContext, YamlValue } from "./types.ts";

const ENV_TOKEN = /\$\{([^}]*)\}/g;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);

export interface ModelCatalog {
  readonly providers: Record<string, Record<string, YamlValue>>;
  readonly [key: string]: YamlValue;
}

export interface ModelMetadata {
  readonly providerId: string;
  readonly model: string;
  readonly envNames: readonly string[];
}

export interface ModelConnection {
  readonly selector: string;
  readonly baseUrl: string;
}

export interface LoadedModelBundle {
  readonly catalog: ModelCatalog;
  readonly source: string;
  readonly connections: readonly ModelConnection[];
  readonly metadata: readonly ModelMetadata[];
  readonly envNames: readonly string[];
}

export function modelCatalogPath(project: ProjectContext): string {
  return resolveInside(project.rootDir, "models.yml");
}

export function emptyModelCatalog(): string {
  return "providers: {}\n";
}

export function splitModelSelector(selector: string): { providerId: string; modelId: string } {
  const slash = selector.indexOf("/");
  if (slash < 1 || slash === selector.length - 1) {
    throw new Error("model selector must use provider/model form");
  }
  const providerId = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  if (!PROVIDER_ID.test(providerId)) throw new Error(`provider id '${providerId}' is unsafe`);
  if (!modelId.trim() || /[\n\0]/.test(modelId) || modelId.includes("${") || modelId.includes("../")) {
    throw new Error(`model id '${modelId}' is unsafe`);
  }
  return { providerId, modelId };
}

export function providerCredentialEnvName(providerId: string): string {
  const normalized = providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");
  return `${normalized}_API_KEY`;
}

export function parseModelCatalog(
  source: string,
  contextLabel: string,
  allowEmpty = false,
): ModelCatalog {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${contextLabel}: ${error.message}`);
    throw error;
  }
  const root = asRecord(parsed, `${contextLabel}: expected a YAML mapping`);
  const providers = asRecord(root.providers, `${contextLabel}: providers must be a YAML mapping`);
  const providerIds = Object.keys(providers);
  if (!allowEmpty && providerIds.length === 0) {
    throw new Error(`${contextLabel}: providers must contain at least one provider; run 'omp-bundler model add <provider/model>'`);
  }

  for (const providerId of providerIds) {
    if (!PROVIDER_ID.test(providerId)) throw new Error(`${contextLabel}: provider id '${providerId}' is unsafe`);
    const provider = asRecord(providers[providerId], `${contextLabel}: provider '${providerId}' must be a mapping`);
    const models = provider.models;
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`${contextLabel}: provider '${providerId}' must contain at least one model`);
    }
    if (provider.auth === "none" && provider.apiKey !== undefined) {
      throw new Error(`${contextLabel}: provider '${providerId}' cannot set both auth: none and apiKey`);
    }
    if (provider.auth !== "none") {
      if (typeof provider.apiKey !== "string" || !isEnvTemplate(provider.apiKey)) {
        throw new Error(`${contextLabel}: provider '${providerId}'.apiKey must be a \${PROVIDER_API_KEY} placeholder or use auth: none`);
      }
    }

    const seen = new Set<string>();
    for (const modelValue of models) {
      const model = asRecord(modelValue, `${contextLabel}: provider '${providerId}' models must be mappings`);
      const modelId = model.id;
      if (typeof modelId !== "string") throw new Error(`${contextLabel}: provider '${providerId}' model id must be a string`);
      splitModelSelector(`${providerId}/${modelId}`);
      if (seen.has(modelId)) throw new Error(`${contextLabel}: provider '${providerId}' repeats model '${modelId}'`);
      seen.add(modelId);
      const baseUrl = stringValue(model.baseUrl) ?? stringValue(provider.baseUrl);
      const api = stringValue(model.api) ?? stringValue(provider.api);
      if (!baseUrl || !isValidBaseUrl(baseUrl)) {
        throw new Error(`${contextLabel}: '${providerId}/${modelId}' must resolve an HTTP(S) baseUrl or environment placeholder`);
      }
      if (!api || !SUPPORTED_APIS.has(api)) {
        throw new Error(`${contextLabel}: '${providerId}/${modelId}' api must be one of: ${[...SUPPORTED_APIS].join(", ")}`);
      }
    }
  }

  return { ...root, providers: providers as Record<string, Record<string, YamlValue>> };
}

export function renderModelCatalog(catalog: ModelCatalog): string {
  return stringifyYaml(catalog);
}

export function modelCatalogEnvNames(catalog: ModelCatalog, contextLabel: string): readonly string[] {
  const names = new Set<string>();
  const visit = (value: YamlValue, path: string): void => {
    if (typeof value === "string") {
      for (const name of placeholderNames(value, `${contextLabel} [${path}]`)) names.add(name);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}.${index}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, path ? `${path}.${key}` : key);
    }
  };
  visit(catalog, "");
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function catalogHasSelector(catalog: ModelCatalog, selector: string): boolean {
  const { providerId, modelId } = splitModelSelector(selector);
  const provider = catalog.providers[providerId];
  if (!provider || !Array.isArray(provider.models)) return false;
  return provider.models.some((value) => isRecord(value) && value.id === modelId);
}

export function catalogSelectors(catalog: ModelCatalog): readonly string[] {
  const selectors: string[] = [];
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const value of models) {
      if (isRecord(value) && typeof value.id === "string") selectors.push(`${providerId}/${value.id}`);
    }
  }
  return selectors.sort((left, right) => left.localeCompare(right));
}

export function addCatalogModel(
  catalog: ModelCatalog,
  providerId: string,
  provider: Record<string, YamlValue>,
  model: Record<string, YamlValue>,
): { catalog: ModelCatalog; changed: boolean } {
  const existing = catalog.providers[providerId];
  if (existing) {
    const models = Array.isArray(existing.models) ? existing.models : [];
    if (models.some((value) => isRecord(value) && value.id === model.id)) return { catalog, changed: false };
    return {
      catalog: {
        ...catalog,
        providers: {
          ...catalog.providers,
          [providerId]: { ...existing, models: [...models, model] },
        },
      },
      changed: true,
    };
  }
  return {
    catalog: {
      ...catalog,
      providers: { ...catalog.providers, [providerId]: { ...provider, models: [model] } },
    },
    changed: true,
  };
}

export async function loadBundleModels(rootDir: string, agents: readonly AgentDirectory[]): Promise<LoadedModelBundle> {
  if (agents.length !== 1) throw new Error(`${rootDir}: exactly one root agent is required`);
  const path = resolveInside(rootDir, "models.yml");
  const info = await lstat(path).catch(() => null);
  if (!info) throw new Error(`${path}: model catalog is missing`);
  if (info.isSymbolicLink()) throw new Error(`${path}: model catalog must not be a symlink`);
  if (!info.isFile()) throw new Error(`${path}: model catalog must be a regular file`);
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    throw new Error(`${path}: cannot read model catalog: ${error instanceof Error ? error.message : String(error)}`);
  });
  const catalog = parseModelCatalog(source, path);
  const envNames = modelCatalogEnvNames(catalog, path);
  const connections: ModelConnection[] = [];
  const metadata: ModelMetadata[] = [];
  for (const selector of catalogSelectors(catalog)) {
    const { providerId, modelId } = splitModelSelector(selector);
    const provider = catalog.providers[providerId];
    const model = (provider.models as YamlValue[]).find((value) => isRecord(value) && value.id === modelId) as Record<string, YamlValue>;
    connections.push({ selector, baseUrl: stringValue(model.baseUrl) ?? stringValue(provider.baseUrl)! });
    metadata.push({ providerId, model: modelId, envNames });
  }

  const configPath = join(agents[0].path, "config.yml");
  const configSource = await readFile(configPath, "utf8");
  const config = asRecord(parseYaml(configSource), `${configPath}: expected a YAML mapping`);
  const roles = isRecord(config.modelRoles) ? config.modelRoles : undefined;
  const defaultModel = roles?.default;
  if (typeof defaultModel !== "string" || !defaultModel.trim()) {
    throw new Error(`${configPath}: modelRoles.default is missing; run 'omp-bundler model set-default <provider/model>'`);
  }
  if (!catalogHasSelector(catalog, defaultModel)) {
    throw new Error(`${configPath}: modelRoles.default '${defaultModel}' is not present in models.yml`);
  }

  return { catalog, source, connections, metadata, envNames };
}

export function setDefaultModelBinding(source: string, selector: string, contextLabel: string): string {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${contextLabel}: ${error.message}`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${contextLabel}: expected a YAML mapping`);
  if (parsed.modelRoles !== undefined && !isRecord(parsed.modelRoles)) {
    throw new Error(`${contextLabel}: modelRoles must be a block mapping`);
  }
  const lines = splitYamlLines(source);
  const rolesLine = lines.findIndex((line) => indentOf(line.body) === 0 && yamlKey(line.body) === "modelRoles");
  const binding = `default: ${quoteYamlScalar(selector)}`;
  const ending = yamlLineEnding(source);
  if (rolesLine < 0) {
    return `${source}${source.endsWith("\n") || source.endsWith("\r") ? "" : ending}modelRoles:${ending}  ${binding}${ending}`;
  }
  if (lines[rolesLine].body.slice(lines[rolesLine].body.indexOf(":") + 1).trim()) {
    throw new Error(`${contextLabel}: modelRoles must be a block mapping`);
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
    const comment = lines[defaultLine].body.slice(colon + 1).match(/(\s+#.*)$/)?.[1] ?? "";
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

export function readDefaultModel(source: string): string | undefined {
  const parsed = parseYaml(source);
  if (!isRecord(parsed) || !isRecord(parsed.modelRoles)) return undefined;
  return typeof parsed.modelRoles.default === "string" ? parsed.modelRoles.default : undefined;
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

function placeholderNames(value: string, contextLabel: string): readonly string[] {
  const names: string[] = [];
  const remainder = value.replace(ENV_TOKEN, (_token, name: string) => {
    if (!ENV_NAME.test(name)) throw new Error(`${contextLabel}: contains a malformed environment placeholder`);
    names.push(name);
    return "";
  });
  if (remainder.includes("${")) throw new Error(`${contextLabel}: contains a malformed environment placeholder`);
  return [...new Set(names)];
}

function isValidBaseUrl(value: string): boolean {
  const shaped = placeholderShape(value);
  if (shaped === undefined) return false;
  try {
    const url = new URL(shaped);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return isEnvTemplate(value);
  }
}

function placeholderShape(value: string): string | undefined {
  if (!value.includes("${")) return value;
  let malformed = false;
  const shaped = value.replace(ENV_TOKEN, (_token, name: string) => {
    if (!ENV_NAME.test(name)) malformed = true;
    return "placeholder";
  });
  return malformed || shaped.includes("${") ? undefined : shaped;
}

function isEnvTemplate(value: string): boolean {
  const match = value.match(/^\$\{([^}]*)\}$/);
  return match !== null && ENV_NAME.test(match[1]);
}

function asRecord(value: YamlValue | undefined, error: string = "expected a YAML mapping"): Record<string, YamlValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value;
}

function isRecord(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: YamlValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function quoteYamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
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
