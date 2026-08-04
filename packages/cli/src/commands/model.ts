import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionBoolean, optionString } from "../args.ts";
import { applyFilePlan, createFilePlan } from "../file-plan.ts";
import {
  addCatalogModel,
  catalogHasSelector,
  catalogSelectors,
  modelCatalogEnvNames,
  modelCatalogPath,
  parseModelCatalog,
  providerCredentialEnvName,
  readDefaultModel,
  renderModelCatalog,
  setDefaultModelBinding,
  splitModelSelector,
} from "../model-config.ts";
import { importOmpModel } from "../omp-model-import.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments, PlannedWrite, ProjectContext, YamlValue } from "../types.ts";
import { assertAllowedOptions } from "./common.ts";
import { assertNoSymlinkComponents, readOptionalTextFile, relativePlanPath } from "./support.ts";
import { runtimeEnvExample, updateModelEnvBlock } from "./templates.ts";

const ADD_OPTIONS = ["from", "base-url", "api", "api-key-env", "no-auth"] as const;

export const MODEL_HELP = [
  "omp-bundler model add <provider/model> [--from omp]",
  "omp-bundler model add <provider/model> --base-url <url> --api <dialect> [--api-key-env <NAME> | --no-auth]",
  "omp-bundler model set-default <provider/model>",
  "omp-bundler model list",
].join("\n");

export const modelCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${MODEL_HELP}\n`);
    return 0;
  }
  const [action, ...positionals] = args.positionals;
  if (action === "add") return addModel(args, positionals, context);
  if (action === "set-default") return setDefaultModel(args, positionals, context);
  if (action === "list") return listModels(args, positionals, context);
  throw new Error(`usage:\n${MODEL_HELP}`);
};

async function addModel(
  args: ParsedArguments,
  positionals: readonly string[],
  context: CommandContext,
): Promise<number> {
  assertAllowedOptions(args, ADD_OPTIONS);
  if (positionals.length !== 1) throw new Error("usage: omp-bundler model add <provider/model>");
  const selector = positionals[0];
  const { providerId, modelId } = splitModelSelector(selector);
  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agent.path, "agent source");
  const path = modelCatalogPath(project);
  const existingFile = await readOptionalTextFile(path, "model catalog");
  if (!existingFile) throw new Error(`${path}: model catalog is missing`);
  const catalog = parseModelCatalog(existingFile.content, path, true);
  const existingProvider = catalog.providers[providerId];

  const manual = ADD_OPTIONS.some((name) => name !== "from" && args.options[name] !== undefined);
  const source = optionString(args, "from") ?? "omp";
  if (source !== "omp") throw new Error(`unsupported model source '${source}'; available sources: omp`);
  if (manual && args.options.from !== undefined) throw new Error("--from cannot be combined with manual provider flags");

  let provider: Record<string, YamlValue>;
  let model: Record<string, YamlValue>;
  let credential: { readonly name: string; readonly value: string } | undefined;
  if (manual) {
    provider = manualProvider(args, providerId, existingProvider);
    model = { id: modelId, name: modelId };
  } else {
    const imported = await importOmpModel(selector, context.cwd);
    provider = imported.provider;
    model = imported.model;
    if (!existingProvider) credential = imported.credential;
  }

  const added = addCatalogModel(catalog, providerId, provider, model);
  const yaml = renderModelCatalog(added.catalog);
  parseModelCatalog(yaml, path);
  const envNames = modelCatalogEnvNames(added.catalog, path);
  if (credential && !envNames.includes(credential.name)) {
    throw new Error(`imported credential '${credential.name}' is not referenced by models.yml`);
  }

  const writes: PlannedWrite[] = [];
  if (added.changed || yaml !== existingFile.content) {
    writes.push({ path: relativePlanPath(project.rootDir, path), content: yaml, overwrite: true });
  }
  const envExamplePath = join(project.rootDir, "runtime.env.example");
  const envExampleFile = await readOptionalTextFile(envExamplePath, "runtime env example");
  const envExampleSource = envExampleFile?.content ?? runtimeEnvExample();
  const updatedEnvExample = updateModelEnvBlock(envExampleSource, envNames);
  if (updatedEnvExample !== envExampleSource) {
    writes.push({ path: "runtime.env.example", content: updatedEnvExample, overwrite: true });
  }
  await addRuntimeCredentialWrite(project, updatedEnvExample, credential, writes);

  if (writes.length > 0) {
    await applyFilePlan(await createFilePlan(project.rootDir, writes));
  }
  context.io.stdout.write(`${added.changed ? "added" : "already present"} ${selector}\n`);
  if (credential) context.io.stdout.write(`updated runtime.env credential ${credential.name} (value redacted)\n`);
  return 0;
}

function manualProvider(
  args: ParsedArguments,
  providerId: string,
  existing: Record<string, YamlValue> | undefined,
): Record<string, YamlValue> {
  const baseUrl = optionString(args, "base-url");
  const api = optionString(args, "api");
  const apiKeyEnv = optionString(args, "api-key-env");
  const noAuth = optionBoolean(args, "no-auth");
  if (apiKeyEnv && noAuth) throw new Error("--api-key-env and --no-auth are mutually exclusive");
  if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error("--api-key-env must be an uppercase environment variable name");
  if (existing) {
    if (baseUrl && existing.baseUrl !== baseUrl) throw new Error(`provider '${providerId}' already has a different baseUrl`);
    if (api && existing.api !== api) throw new Error(`provider '${providerId}' already has a different api`);
    if (apiKeyEnv || noAuth) throw new Error(`provider '${providerId}' credentials already exist; model add only appends models`);
    return existing;
  }
  if (!baseUrl) throw new Error("--base-url is required when adding a custom provider");
  if (!api) throw new Error("--api is required when adding a custom provider");
  return {
    baseUrl,
    api,
    ...(noAuth
      ? { auth: "none" }
      : { apiKey: `\${${apiKeyEnv ?? providerCredentialEnvName(providerId)}}` }),
    models: [],
  };
}

async function setDefaultModel(
  args: ParsedArguments,
  positionals: readonly string[],
  context: CommandContext,
): Promise<number> {
  assertAllowedOptions(args, []);
  if (positionals.length !== 1) throw new Error("usage: omp-bundler model set-default <provider/model>");
  const selector = positionals[0];
  const project = await loadProject(undefined, context.cwd);
  const path = modelCatalogPath(project);
  const catalog = parseModelCatalog(await readFile(path, "utf8"), path);
  if (!catalogHasSelector(catalog, selector)) throw new Error(`model '${selector}' is not present in models.yml`);
  const configPath = join(project.rootDir, "config.yml");
  const source = await readFile(configPath, "utf8");
  const updated = setDefaultModelBinding(source, selector, configPath);
  if (updated !== source) {
    await applyFilePlan(await createFilePlan(project.rootDir, [{ path: "config.yml", content: updated, overwrite: true }]));
  }
  context.io.stdout.write(`default model: ${selector}\n`);
  return 0;
}

async function listModels(
  args: ParsedArguments,
  positionals: readonly string[],
  context: CommandContext,
): Promise<number> {
  assertAllowedOptions(args, []);
  if (positionals.length !== 0) throw new Error("usage: omp-bundler model list");
  const project = await loadProject(undefined, context.cwd);
  const path = modelCatalogPath(project);
  const catalog = parseModelCatalog(await readFile(path, "utf8"), path, true);
  const configSource = await readFile(join(project.rootDir, "config.yml"), "utf8");
  const defaultModel = readDefaultModel(configSource);
  const selectors = catalogSelectors(catalog);
  if (selectors.length === 0) {
    context.io.stdout.write("No models configured.\n");
    return 0;
  }
  for (const selector of selectors) {
    context.io.stdout.write(`${selector === defaultModel ? "*" : " "} ${selector}\n`);
  }
  return 0;
}

async function addRuntimeCredentialWrite(
  project: ProjectContext,
  envExample: string,
  credential: { readonly name: string; readonly value: string } | undefined,
  writes: PlannedWrite[],
): Promise<void> {
  if (!credential) return;
  const gitignore = await readOptionalTextFile(join(project.rootDir, ".gitignore"), "gitignore");
  const ignoresRuntime = gitignore?.content.split(/\r?\n/).some((line) => line.trim() === "runtime.env" || line.trim() === "/runtime.env");
  if (!ignoresRuntime) throw new Error("refusing to write a credential until .gitignore contains runtime.env");
  const runtimeFile = await readOptionalTextFile(join(project.rootDir, "runtime.env"), "runtime env");
  const source = removeLegacyModelCredentials(runtimeFile?.content ?? envExample);
  writes.push({
    path: "runtime.env",
    content: updateRuntimeEnvValue(source, credential.name, credential.value),
    overwrite: true,
    mode: 0o600,
  });
}

function removeLegacyModelCredentials(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*OMP_MODEL_[A-Z0-9_]+_API_KEY\s*=/.test(line))
    .join("\n")
    .replace(/\n*$/, "\n");
}

function updateRuntimeEnvValue(source: string, name: string, value: string): string {
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`credential '${name}' cannot be represented in a Docker env file`);
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length > 1) throw new Error(`runtime.env declares ${name} more than once`);
  const assignment = `${name}=${value}`;
  if (matches.length === 1) return source.replace(pattern, () => assignment);
  return `${source.trimEnd()}\n${assignment}\n`;
}
