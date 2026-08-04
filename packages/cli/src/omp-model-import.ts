import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseYaml } from "./config.ts";
import {
  providerCredentialEnvName,
  splitModelSelector,
} from "./model-config.ts";
import { executeChild } from "./process.ts";
import type { YamlValue } from "./types.ts";

const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);
const ENV_TEMPLATE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

interface OmpModelListing {
  readonly models?: readonly {
    readonly provider?: unknown;
    readonly id?: unknown;
    readonly selector?: unknown;
  }[];
}

export interface ImportedOmpModel {
  readonly selector: string;
  readonly providerId: string;
  readonly provider: Record<string, YamlValue>;
  readonly model: Record<string, YamlValue>;
  readonly credential?: {
    readonly name: string;
    readonly value: string;
  };
}

/** Resolve one exact provider/model selector through the installed OMP CLI. */
export async function importOmpModel(selector: string, cwd: string): Promise<ImportedOmpModel> {
  const { providerId, modelId } = splitModelSelector(selector);
  const listingResult = await runOmp(["models", providerId, "--json"], cwd, "list models");
  let listing: OmpModelListing;
  try {
    listing = JSON.parse(listingResult) as OmpModelListing;
  } catch {
    throw new Error("OMP returned invalid JSON while listing models");
  }
  const matches = (listing.models ?? []).filter((model) =>
    model.provider === providerId && model.id === modelId && model.selector === selector
  );
  if (matches.length !== 1) throw new Error(`OMP could not resolve exact model '${selector}'`);

  const configDirOutput = await runOmp(["config", "path", "--json"], cwd, "locate configuration");
  const configDir = parseConfigPath(configDirOutput, cwd);
  const source = await readOmpModelsConfig(configDir);
  const root = asRecord(parseYaml(source), "OMP models config");
  const providers = asRecord(root.providers, "OMP models config providers");
  const sourceProvider = asRecord(providers[providerId], `OMP provider '${providerId}'`);
  const sourceModels = Array.isArray(sourceProvider.models) ? sourceProvider.models : [];
  const configuredModel = sourceModels
    .map((model) => asRecord(model, `OMP provider '${providerId}' model`))
    .find((model) => model.id === modelId);

  if (sourceProvider.transport !== undefined || sourceProvider.headers !== undefined || configuredModel?.headers !== undefined) {
    throw new Error(`OMP model '${selector}' uses transport or headers that cannot be exported safely`);
  }
  if (sourceProvider.auth === "oauth") {
    throw new Error(`OMP model '${selector}' uses OAuth credentials that cannot be exported as a durable API key`);
  }

  const baseUrl = stringValue(configuredModel?.baseUrl) ?? stringValue(sourceProvider.baseUrl);
  const api = stringValue(configuredModel?.api) ?? stringValue(sourceProvider.api);
  if (!baseUrl || !api) throw new Error(`OMP provider '${providerId}' does not expose a complete baseUrl and api`);
  if (!SUPPORTED_APIS.has(api)) throw new Error(`OMP model '${selector}' uses unsupported API '${api}'`);

  const model: Record<string, YamlValue> = configuredModel
    ? { ...configuredModel, id: modelId, name: stringValue(configuredModel.name) ?? modelId }
    : { id: modelId, name: modelId };
  delete model.baseUrl;
  delete model.api;

  if (sourceProvider.auth === "none") {
    return {
      selector,
      providerId,
      provider: { baseUrl, api, auth: "none", models: [] },
      model,
    };
  }

  const token = await runOmp(["token", providerId, "--raw"], cwd, "resolve credential");
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`OMP credential for '${providerId}' is empty or cannot be represented in a Docker env file`);
  }
  const configuredName = typeof sourceProvider.apiKey === "string"
    ? ENV_TEMPLATE.exec(sourceProvider.apiKey)?.[1]
    : undefined;
  const credentialName = configuredName ?? providerCredentialEnvName(providerId);
  return {
    selector,
    providerId,
    provider: { baseUrl, api, apiKey: `\${${credentialName}}`, models: [] },
    model,
    credential: { name: credentialName, value: token },
  };
}

async function runOmp(args: readonly string[], cwd: string, action: string): Promise<string> {
  const result = await executeChild("omp", args, { cwd, stdio: "pipe", forwardSignals: false });
  if (result.exitCode !== 0) throw new Error(`could not ${action} through OMP (exit ${result.exitCode})`);
  return result.stdout.trim();
}

function parseConfigPath(output: string, cwd: string): string {
  let value = output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed === "string") value = parsed;
  } catch {
    // OMP 17 prints the path directly even when --json is supplied.
  }
  if (!value || /[\r\n]/.test(value)) throw new Error("OMP returned an invalid configuration path");
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

async function readOmpModelsConfig(configDir: string): Promise<string> {
  for (const name of ["models.yml", "models.yaml"]) {
    try {
      return await readFile(join(configDir, name), "utf8");
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`OMP has no local models.yml or models.yaml under ${configDir}`);
}

function asRecord(value: YamlValue | undefined, label: string): Record<string, YamlValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return value;
}

function stringValue(value: YamlValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
