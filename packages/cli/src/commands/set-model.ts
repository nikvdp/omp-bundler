import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { optionString } from "../args.ts";
import { parseYaml, YamlError } from "../config.ts";
import { applyFilePlan, createFilePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { executeChild } from "../process.ts";
import { discoverAgents, loadProject, resolveAgentPath } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments, PlannedWrite, ProjectContext, YamlValue } from "../types.ts";
import { assertNoLegacyOmpSource } from "./common.ts";
import { assertNoSymlinkComponents, readOptionalTextFile, relativePlanPath } from "./support.ts";
import {
  MODEL_FIELDS,
  modelConfigEnvNames,
  modelConfigPath,
  parseModelConfig,
  renderModelTemplate,
  resolveDefaultValue,
  type CliModelField,
  type ModelConfig,
} from "../model-config.ts";
import { runtimeEnvExample, updateAgentModelEnvBlock } from "./templates.ts";

/** Fields that have a CLI flag, derived from MODEL_FIELDS. */
const CLI_FIELDS: readonly CliModelField[] = MODEL_FIELDS.filter((field): field is CliModelField => field.flag !== undefined);
const DIRECT_FLAGS: readonly string[] = CLI_FIELDS.map((field) => field.flag);

const ALL_ALLOWED_OPTIONS = ["help", "wizard", "print-template", ...DIRECT_FLAGS];

export const SET_MODEL_HELP = buildHelp();

function buildHelp(): string {
  const usageFlags = CLI_FIELDS.map((field) => `[--${field.flag} <value>]`).join(" ");
  const lines = [
    "omp-bundler set-model [agent-id]",
    "omp-bundler set-model [agent-id] --wizard",
    `omp-bundler set-model [agent-id] ${usageFlags}`,
    "omp-bundler set-model [agent-id] --print-template",
    "",
    "Fields:",
    ...CLI_FIELDS.map((field) => `  [--${field.flag} <value>]  ${field.description}${field.required ? " (required when creating)" : ""}`),
  ];
  return lines.join("\n");
}

export const setModelCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${SET_MODEL_HELP}\n`);
    return 0;
  }
  rejectUnknownOptions(args, ALL_ALLOWED_OPTIONS);

  const modes = [
    args.options.wizard === true,
    args.options["print-template"] === true,
    DIRECT_FLAGS.some((flag) => args.options[flag] !== undefined),
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error("--wizard, --print-template, and direct flags are mutually exclusive; use one mode at a time");
  }

  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");

  const agentId = await resolveAgentId(args, project);
  await assertAgentExists(project, agentId);

  const configPath = modelConfigPath(project, agentId);

  if (args.options["print-template"] === true) {
    const existingFile = await readOptionalTextFile(configPath, "model config");
    const existing = existingFile ? parseModelConfig(existingFile.content, configPath) : undefined;
    context.io.stdout.write(renderModelTemplate(agentId, existing));
    return 0;
  }

  if (args.options.wizard === true) {
    return runWizard(context, project, agentId, configPath);
  }

  if (DIRECT_FLAGS.some((flag) => args.options[flag] !== undefined)) {
    return runDirectFlags(args, context, project, agentId, configPath);
  }

  return runEditor(context, project, agentId, configPath);
};

async function resolveAgentId(args: ParsedArguments, project: ProjectContext): Promise<string> {
  if (args.positionals.length > 1) {
    throw new Error("usage: omp-bundler set-model [agent-id]");
  }
  if (args.positionals.length === 1) {
    return assertSafeIdentifier(args.positionals[0], "agent id");
  }
  const agents = await discoverAgents(project.agentsDir);
  if (agents.length === 0) throw new Error("no agents found; create one with 'omp-bundler new'");
  if (agents.length > 1) {
    const ids = agents.map((agent) => agent.id).join(", ");
    throw new Error(`multiple agents found (${ids}); specify the agent id explicitly`);
  }
  return agents[0].id;
}

async function assertAgentExists(project: ProjectContext, agentId: string): Promise<void> {
  const agentPath = resolveAgentPath(project, agentId);
  const info = await lstat(agentPath).catch(() => null);
  if (!info) throw new Error(`agent '${agentId}' does not exist: ${agentPath}`);
  if (info.isSymbolicLink()) throw new Error(`agent path must not be a symlink: ${agentPath}`);
  if (!info.isDirectory()) throw new Error(`agent path is not a directory: ${agentPath}`);
  await assertNoLegacyOmpSource(agentPath, agentId);
  await assertNoSymlinkComponents(project.agentsDir, agentPath, "agent path");
}

async function runEditor(
  context: CommandContext,
  project: ProjectContext,
  agentId: string,
  configPath: string,
): Promise<number> {
  const existingFile = await readOptionalTextFile(configPath, "model config");
  const template = existingFile?.content ?? renderModelTemplate(agentId, undefined);
  const isNewFile = !existingFile;

  const tempDir = await mkdtemp(join(tmpdir(), "omp-set-model-"));
  const tempPath = join(tempDir, `${agentId}.yml`);
  try {
    await writeFile(tempPath, template, { encoding: "utf8", mode: 0o600 });
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const result = await executeChild(editor, [tempPath], { stdio: "inherit" });
    if (result.exitCode !== 0) {
      throw new Error(`editor '${editor}' exited with code ${result.exitCode}; configuration not changed`);
    }
    const edited = await readFile(tempPath, "utf8");
    if (edited === template) {
      if (isNewFile) {
        context.io.stdout.write(`unchanged ${relativePlanPath(project.rootDir, configPath)}\n`);
        return 0;
      }
      parseModelConfig(edited, configPath);
      return commitConfig(context, project, agentId, configPath, edited, existingFile!.content);
    }
    parseModelConfig(edited, configPath);
    return commitConfig(context, project, agentId, configPath, edited, existingFile?.content);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runWizard(
  context: CommandContext,
  project: ProjectContext,
  agentId: string,
  configPath: string,
): Promise<number> {
  const existingFile = await readOptionalTextFile(configPath, "model config");
  const existing = existingFile ? parseModelConfig(existingFile.content, configPath) : undefined;
  const hasExisting = existing !== undefined;
  const rl = createInterface({ input: context.io.stdin, output: context.io.stdout });
  try {
    const values: Record<string, string> = {};
    for (const field of MODEL_FIELDS) {
      if (!field.flag) continue;
      const current = hasExisting ? existing![field.key as keyof ModelConfig] : undefined;
      const hasCurrent = current !== undefined;
      const displayCurrent = hasCurrent
        ? (field.secret ? (current ? "<redacted>" : "no auth") : current)
        : undefined;
      const suffix = hasCurrent
        ? ` [current: ${displayCurrent}]`
        : (resolveDefaultValue(field, agentId) ? ` [default: ${resolveDefaultValue(field, agentId)}]` : "");
      const prompt = `${field.label}${suffix}: `;
      let answer: string;
      if (field.choices) {
        const fullPrompt = `${prompt}(${field.choices.join(" / ")}): `;
        answer = (await rl.question(fullPrompt)).trim();
        if (!answer) {
          answer = hasCurrent ? (current as string) : resolveDefaultValue(field, agentId) ?? "";
        } else if (!field.choices.includes(answer)) {
          throw new Error(`invalid choice '${answer}'; must be one of: ${field.choices.join(", ")}`);
        }
      } else if (field.secret) {
        context.io.stdout.write(prompt);
        const muted = muteWritable(context.io.stdout);
        try {
          answer = (await rl.question("")).trim();
        } finally {
          muted.restore();
        }
        context.io.stdout.write("\n");
        if (!answer) {
          if (hasCurrent) {
            answer = current as string;
          } else {
            answer = resolveDefaultValue(field, agentId) ?? "";
          }
        } else if (answer === '""') {
          answer = "";
        }
      } else {
        answer = (await rl.question(prompt)).trim();
        if (!answer) {
          if (hasCurrent) {
            answer = current as string;
          } else {
            const defaultValue = resolveDefaultValue(field, agentId);
            if (defaultValue) {
              answer = defaultValue;
            } else if (field.required) {
              throw new Error(`${field.label} is required`);
            } else {
              answer = "";
            }
          }
        }
      }
      values[field.key] = answer;
    }
    const config: ModelConfig = {
      version: 1,
      baseUrl: values.baseUrl,
      dialect: values.dialect,
      model: values.model,
      apiKey: values.apiKey,
    };
    validateConfig(config, configPath);
    return await commitConfig(context, project, agentId, configPath, config, existingFile?.content);
  } finally {
    rl.close();
  }
}

/** Mute a Writable's write method until restore() is called. */
function muteWritable(target: Writable): { restore: () => void } {
  const original = target.write;
  target.write = (() => true) as typeof original;
  return { restore: () => { target.write = original; } };
}

async function runDirectFlags(
  args: ParsedArguments,
  context: CommandContext,
  project: ProjectContext,
  agentId: string,
  configPath: string,
): Promise<number> {
  const existingFile = await readOptionalTextFile(configPath, "model config");
  const existing = existingFile ? parseModelConfig(existingFile.content, configPath) : undefined;
  const isCreating = !existing;

  const baseUrl = optionString(args, "base-url") ?? existing?.baseUrl;
  const dialect = optionString(args, "dialect") ?? existing?.dialect;
  const model = optionString(args, "model") ?? existing?.model;

  if (!baseUrl) throw new Error(isCreating ? "--base-url is required when creating a new model config" : "baseUrl must be a non-empty string");
  if (!dialect) throw new Error(isCreating ? "--dialect is required when creating a new model config" : "dialect must be a non-empty string");
  if (!model) throw new Error(isCreating ? "--model is required when creating a new model config" : "model must be a non-empty string");

  const apiKeyField = MODEL_FIELDS.find((field) => field.key === "apiKey")!;
  const apiKeyOption = optionString(args, "api-key");
  const apiKey = apiKeyOption !== undefined
    ? (apiKeyOption === '""' ? "" : apiKeyOption)
    : existing
      ? existing.apiKey
      : resolveDefaultValue(apiKeyField, agentId) ?? "";

  const config: ModelConfig = { version: 1, baseUrl, dialect, model, apiKey };
  validateConfig(config, configPath);
  return await commitConfig(context, project, agentId, configPath, config, existingFile?.content);
}

function validateConfig(config: ModelConfig, configPath: string): void {
  const yaml = renderModelYaml(config);
  parseModelConfig(yaml, configPath);
}

function renderModelYaml(config: ModelConfig): string {
  const lines = [
    `version: ${config.version}`,
    `baseUrl: ${quoteYaml(config.baseUrl)}`,
    `dialect: ${config.dialect}`,
    `model: ${quoteYaml(config.model)}`,
    `apiKey: ${config.apiKey === "" ? '""' : quoteYaml(config.apiKey)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function quoteYaml(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Commit model config. When content is a string (editor mode), it is the
 * exact edited source written verbatim. When it is a ModelConfig (wizard/
 * direct), it is canonical-rendered. Always checks legacy config.yml
 * modelRoles.default for transactional removal.
 */
async function commitConfig(
  context: CommandContext,
  project: ProjectContext,
  agentId: string,
  configPath: string,
  content: string | ModelConfig,
  existingContent: string | undefined,
): Promise<number> {
  const yaml = typeof content === "string" ? content : renderModelYaml(content);
  const modelChanged = existingContent !== yaml;

  // Derive the generated env names for this agent's committed model config so
  // runtime.env.example stays in sync in the same transaction.
  const committedConfig = typeof content === "string" ? parseModelConfig(yaml, configPath) : content;
  const envNames = modelConfigEnvNames(committedConfig, configPath);

  const writes: PlannedWrite[] = [];
  if (modelChanged) {
    writes.push({ path: relativePlanPath(project.rootDir, configPath), content: yaml, overwrite: true });
  }

  const agentPath = resolveAgentPath(project, agentId);
  const configYmlPath = join(agentPath, "config.yml");
  const configYmlFile = await readOptionalTextFile(configYmlPath, "agent config");
  let legacyRemoved = false;
  if (configYmlFile) {
    const updated = removeModelRolesDefault(configYmlFile.content, configYmlPath);
    if (updated !== configYmlFile.content) {
      writes.push({ path: relativePlanPath(project.rootDir, configYmlPath), content: updated, overwrite: true });
      legacyRemoved = true;
    }
  }

  // Update (or seed) runtime.env.example's generated block for this agent.
  const envExamplePath = join(project.rootDir, "runtime.env.example");
  const envExampleFile = await readOptionalTextFile(envExamplePath, "runtime env example");
  const envExampleSource = envExampleFile?.content ?? runtimeEnvExample();
  const updatedEnvExample = updateAgentModelEnvBlock(envExampleSource, agentId, envNames);
  let envExampleUpdated = false;
  if (updatedEnvExample !== envExampleSource) {
    writes.push({ path: "runtime.env.example", content: updatedEnvExample, overwrite: true });
    envExampleUpdated = true;
  }

  if (writes.length === 0) {
    context.io.stdout.write(`unchanged ${relativePlanPath(project.rootDir, configPath)}\n`);
    return 0;
  }

  const plan = await createFilePlan(project.rootDir, writes);
  await applyFilePlan(plan);
  if (modelChanged) {
    context.io.stdout.write(`wrote ${relativePlanPath(project.rootDir, configPath)}\n`);
  } else {
    context.io.stdout.write(`unchanged ${relativePlanPath(project.rootDir, configPath)}\n`);
  }
  if (legacyRemoved) {
    context.io.stdout.write(`removed legacy modelRoles.default from ${relativePlanPath(project.rootDir, configYmlPath)}\n`);
  }
  if (envExampleUpdated) {
    context.io.stdout.write(`updated runtime.env.example for ${agentId}\n`);
  }
  return 0;
}

/**
 * Remove modelRoles.default from a config.yml source while preserving other
 * roles, comments, and formatting. Returns the source unchanged if no
 * default role exists. Throws if the config is malformed or the default
 * role cannot be located textually, ensuring atomic cutover.
 */
function removeModelRolesDefault(source: string, configPath: string): string {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${configPath}: ${error.message}`);
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected a YAML mapping`);
  }
  const record = parsed as Record<string, YamlValue>;
  const roles = record.modelRoles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return source;
  if (!("default" in roles)) return source;

  const lines = splitYamlLines(source);
  const modelRolesLine = lines.findIndex((line) => {
    if (line.body.trimStart().startsWith("#")) return false;
    return leadingSpaces(line.body) === 0 && yamlKey(line.body) === "modelRoles";
  });
  if (modelRolesLine < 0) {
    throw new Error(`${configPath}: modelRoles.default exists in parse but could not be located textually; refusing to migrate`);
  }

  const parentIndent = leadingSpaces(lines[modelRolesLine].body);
  let childIndent: number | null = null;
  let defaultIndex = -1;
  let otherRoleCount = 0;
  for (let index = modelRolesLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.body.trim();
    const indent = leadingSpaces(line.body);
    if (trimmed && !trimmed.startsWith("#") && indent <= parentIndent) break;
    if (trimmed && !trimmed.startsWith("#") && indent > parentIndent) {
      childIndent ??= indent;
      if (yamlKey(line.body) === "default" && indent === childIndent) {
        defaultIndex = index;
      } else {
        otherRoleCount += 1;
      }
    }
  }
  if (defaultIndex < 0) {
    throw new Error(`${configPath}: modelRoles.default exists in parse but could not be located textually; refusing to migrate`);
  }

  lines.splice(defaultIndex, 1);

  if (otherRoleCount === 0) {
    lines.splice(modelRolesLine, 1);
    const nextLine = lines[modelRolesLine];
    if (nextLine && nextLine.body.trim() === "") {
      lines.splice(modelRolesLine, 1);
    }
  }

  return joinYamlLines(lines);
}

interface YamlTextLine {
  readonly body: string;
  readonly ending: string;
}

function splitYamlLines(source: string): YamlTextLine[] {
  if (!source) return [];
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

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}

function yamlKey(value: string): string | null {
  const match = value.match(/^\s*([^:#][^:]*)\s*:/);
  return match?.[1].trim() ?? null;
}

function rejectUnknownOptions(args: ParsedArguments, allowed: readonly string[]): void {
  for (const name of Object.keys(args.options)) {
    if (!allowed.includes(name)) throw new Error(`unknown option '--${name}'`);
  }
}
