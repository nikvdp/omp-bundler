import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseYaml } from "./config.ts";
import { defaultApiKeyPlaceholder, type ModelConfig } from "./model-config.ts";
import { executeChild } from "./process.ts";
import type { YamlValue } from "./types.ts";

const SUPPORTED_DIALECTS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);

interface OmpModelListing {
  readonly models?: readonly {
    readonly provider?: unknown;
    readonly id?: unknown;
    readonly selector?: unknown;
  }[];
}

export interface ImportedOmpModel {
  readonly selector: string;
  readonly config: ModelConfig;
  readonly credential?: {
    readonly name: string;
    readonly value: string;
  };
}

/** Resolve one exact provider/model selector through the installed OMP CLI. */
export async function importOmpModel(selector: string, agentId: string, cwd: string): Promise<ImportedOmpModel> {
  const slash = selector.indexOf("/");
  if (slash < 1 || slash === selector.length - 1) {
    throw new Error("--model must be an exact OMP selector in provider/model form");
  }
  const providerId = selector.slice(0, slash);
  const requestedModelId = selector.slice(slash + 1);

  const listingResult = await runOmp(["models", providerId, "--json"], cwd, "list models");
  let listing: OmpModelListing;
  try {
    listing = JSON.parse(listingResult) as OmpModelListing;
  } catch {
    throw new Error("OMP returned invalid JSON while listing models");
  }
  const matches = (listing.models ?? []).filter((model) =>
    model.provider === providerId
    && model.id === requestedModelId
    && model.selector === selector);
  if (matches.length !== 1) {
    throw new Error(`OMP could not resolve exact model '${selector}'`);
  }

  const configDirOutput = await runOmp(["config", "path", "--json"], cwd, "locate configuration");
  const configDir = parseConfigPath(configDirOutput, cwd);
  const source = await readOmpModelsConfig(configDir);
  const root = asRecord(parseYaml(source), "OMP models config");
  const providers = asRecord(root.providers, "OMP models config providers");
  const provider = asRecord(providers[providerId], `OMP provider '${providerId}'`);
  const models = Array.isArray(provider.models) ? provider.models : [];
  const configuredModel = models
    .map((model) => asRecord(model, `OMP provider '${providerId}' model`))
    .find((model) => model.id === requestedModelId);

  if (provider.transport !== undefined || provider.headers !== undefined || configuredModel?.headers !== undefined) {
    throw new Error(`OMP model '${selector}' uses transport or headers that omp-bundler cannot represent`);
  }
  if (provider.auth === "oauth") {
    throw new Error(`OMP model '${selector}' uses OAuth credentials that cannot be exported as a durable API key`);
  }

  const baseUrl = stringValue(configuredModel?.baseUrl) ?? stringValue(provider.baseUrl);
  const dialect = stringValue(configuredModel?.api) ?? stringValue(provider.api);
  if (!baseUrl || !dialect) {
    throw new Error(`OMP provider '${providerId}' does not expose a complete baseUrl and api in its local models config`);
  }
  if (!SUPPORTED_DIALECTS.has(dialect)) {
    throw new Error(`OMP model '${selector}' uses unsupported API dialect '${dialect}'`);
  }

  if (provider.auth === "none") {
    return {
      selector,
      config: { version: 1, baseUrl, dialect, model: requestedModelId, apiKey: "" },
    };
  }

  const token = await runOmp(["token", providerId, "--raw"], cwd, "resolve credential");
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`OMP credential for '${providerId}' is empty or cannot be represented in a Docker env file`);
  }
  const placeholder = defaultApiKeyPlaceholder(agentId);
  const credentialName = placeholder.slice(2, -1);
  return {
    selector,
    config: { version: 1, baseUrl, dialect, model: requestedModelId, apiKey: placeholder },
    credential: { name: credentialName, value: token },
  };
}

async function runOmp(args: readonly string[], cwd: string, action: string): Promise<string> {
  const result = await executeChild("omp", args, { cwd, stdio: "pipe", forwardSignals: false });
  if (result.exitCode !== 0) {
    throw new Error(`could not ${action} through OMP (exit ${result.exitCode})`);
  }
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
