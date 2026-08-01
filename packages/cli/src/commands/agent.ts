import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { optionBoolean } from "../args.ts";
import { applyFilePlan, createFilePlan, createMovePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { loadProject, resolveAgentPath } from "../project.ts";
import type { CommandContext, CommandHandler, FilePlan, ParsedArguments, YamlValue } from "../types.ts";
import { parseYaml } from "../config.ts";
import { assertNoLegacyOmpSource } from "./common.ts";
import {
  assertNoSymlinkComponents,
  assertNoSymlinksRecursively,
  findTextReferences,
  hasExactTextReference,
  printPlan,
  readOptionalTextFile,
  relativePlanPath,
  transformPumbleAgentBinding,
} from "./support.ts";

const AGENT_HELP = [
  "omp-bundler agent model <agent-id> <provider/model>",
  "omp-bundler agent rename <old-agent-id> <new-agent-id>",
].join("\n");

export const agentCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${AGENT_HELP}\n`);
    return 0;
  }
  const subcommand = args.positionals[0];
  if (subcommand === "model") return agentModel(args, context);
  if (subcommand === "rename") return agentRename(args, context);
  throw new Error(`unknown agent subcommand '${subcommand ?? ""}'. Run 'omp-bundler agent --help' for available commands`);
};

async function agentModel(
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  rejectUnknownOptions(args, ["help", "dry-run"]);
  if (args.positionals.length !== 3) {
    throw new Error("usage: omp-bundler agent model <agent-id> <provider/model>");
  }
  const agentId = assertSafeIdentifier(args.positionals[1], "agent id");
  const model = validateModelName(args.positionals[2]);
  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");
  const agentPath = resolveAgentPath(project, agentId);
  await assertNoSymlinkComponents(project.agentsDir, agentPath, "agent path");
  const agentInfo = await lstat(agentPath).catch(() => null);
  if (!agentInfo) throw new Error(`agent '${agentId}' does not exist: ${agentPath}`);
  if (agentInfo.isSymbolicLink()) throw new Error(`agent path must not be a symlink: ${agentPath}`);
  if (!agentInfo.isDirectory()) throw new Error(`agent path is not a directory: ${agentPath}`);
  await assertNoLegacyOmpSource(agentPath, agentId);

  const configPath = join(agentPath, "config.yml");
  const configFile = await readOptionalTextFile(configPath, "agent config");
  if (!configFile) throw new Error(`agent '${agentId}' is missing config.yml: ${configPath}`);
  const updated = updateDefaultModel(configFile.content, model);
  if (updated === configFile.content) {
    context.io.stdout.write(`unchanged ${configPath}\n`);
    return 0;
  }
  const plan = await createFilePlan(project.rootDir, [{
    path: relativePlanPath(project.rootDir, configPath),
    content: updated,
    overwrite: true,
  }]);
  const dryRun = optionBoolean(args, "dry-run");
  printPlan(context, plan, dryRun);
  await applyFilePlan(plan, { dryRun });
  return 0;
}

async function agentRename(
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  rejectUnknownOptions(args, ["help", "dry-run"]);
  if (args.positionals.length !== 3) {
    throw new Error("usage: omp-bundler agent rename <old-agent-id> <new-agent-id>");
  }
  const oldAgentId = assertSafeIdentifier(args.positionals[1], "old agent id");
  const newAgentId = assertSafeIdentifier(args.positionals[2], "new agent id");
  if (oldAgentId === newAgentId) throw new Error("old and new agent ids must differ");

  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");
  const source = resolveAgentPath(project, oldAgentId);
  const destination = resolveAgentPath(project, newAgentId);
  await assertNoSymlinkComponents(project.agentsDir, source, "agent source");
  await assertNoSymlinkComponents(project.agentsDir, destination, "agent destination");
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo) throw new Error(`agent '${oldAgentId}' does not exist: ${source}`);
  if (sourceInfo.isSymbolicLink()) throw new Error(`agent source must not be a symlink: ${source}`);
  if (!sourceInfo.isDirectory()) throw new Error(`agent source is not a directory: ${source}`);
  await assertNoSymlinksRecursively(source, "agent source");
  await assertNoLegacyOmpSource(source, oldAgentId);
  const destinationInfo = await lstat(destination).catch(() => null);
  if (destinationInfo) throw new Error(`agent destination already exists: ${destination}`);

  const envExamplePath = join(project.rootDir, "runtime.env.example");
  const envExample = await readOptionalTextFile(envExamplePath, "runtime.env.example");
  const envChange = envExample
    ? transformPumbleAgentBinding(envExample.content, oldAgentId, newAgentId)
    : null;
  const references = await findTextReferences(project.rootDir, oldAgentId, {
    filter: (path, content) => {
      const candidate = path === envExamplePath && envChange?.changed ? envChange.content : content;
      return hasExactTextReference(candidate, oldAgentId);
    },
  });

  const movePlan = createMovePlan(
    project.rootDir,
    relativePlanPath(project.rootDir, source),
    relativePlanPath(project.rootDir, destination),
  );
  const operations = [...movePlan.operations];
  if (envExample && envChange?.changed) {
    const envPlan = await createFilePlan(project.rootDir, [{
      path: relativePlanPath(project.rootDir, envExamplePath),
      content: envChange.content,
      overwrite: true,
    }]);
    operations.push(...envPlan.operations);
  }
  const plan: FilePlan = { root: movePlan.root, operations };
  const dryRun = optionBoolean(args, "dry-run");
  printPlan(context, plan, dryRun);
  printReferences(context, references);
  await applyFilePlan(plan, { dryRun });
  return 0;
}

function updateDefaultModel(source: string, model: string): string {
  const parsed = parseYaml(source);
  if (!isRecord(parsed)) throw new Error("agent config must be a YAML mapping");
  if (parsed.modelRoles !== undefined && !isRecord(parsed.modelRoles)) {
    throw new Error("agent config modelRoles must be a mapping");
  }

  const lines = splitYamlLines(source);
  const modelRolesLine = lines.findIndex((line) => {
    if (line.body.trimStart().startsWith("#")) return false;
    return leadingSpaces(line.body) === 0 && yamlKey(line.body) === "modelRoles";
  });
  if (modelRolesLine < 0) {
    const ending = detectLineEnding(lines);
    const prefix = source && !source.endsWith("\n") && !source.endsWith("\r") ? ending : "";
    return `${source}${prefix}modelRoles:${ending}  default: ${model}${ending}`;
  }

  const header = lines[modelRolesLine];
  const colon = header.body.indexOf(":");
  const tail = stripYamlComment(header.body.slice(colon + 1)).trim();
  if (tail) {
    if (!(tail.startsWith("{") && tail.endsWith("}"))) {
      throw new Error("agent config modelRoles must be a mapping");
    }
    const inline = updateInlineModel(tail, model);
    lines[modelRolesLine] = { ...header, body: `${header.body.slice(0, colon + 1)}${header.body.slice(colon + 1).replace(tail, inline)}` };
    const result = joinYamlLines(lines);
    verifyUpdatedModel(result, model);
    return result;
  }

  const parentIndent = leadingSpaces(header.body);
  let childIndent: number | null = null;
  let defaultIndex = -1;
  let blockEnd = modelRolesLine + 1;
  for (; blockEnd < lines.length; blockEnd += 1) {
    const line = lines[blockEnd];
    const trimmed = line.body.trim();
    const indent = leadingSpaces(line.body);
    if (trimmed && !trimmed.startsWith("#") && indent <= parentIndent) break;
    if (trimmed && !trimmed.startsWith("#") && indent > parentIndent) {
      childIndent ??= indent;
      if (yamlKey(line.body) === "default" && indent === childIndent) defaultIndex = blockEnd;
    }
  }
  const defaultIndent = childIndent ?? parentIndent + 2;
  if (defaultIndex >= 0) {
    const line = lines[defaultIndex];
    const match = line.body.match(/^(\s*default\s*:\s*)(.*)$/);
    if (!match) throw new Error("agent config modelRoles.default is invalid");
    const valueAndComment = match[2];
    const commentIndex = findYamlComment(valueAndComment);
    const valuePart = commentIndex < 0 ? valueAndComment : valueAndComment.slice(0, commentIndex);
    const trailingWhitespace = valuePart.slice(valuePart.trimEnd().length);
    const comment = commentIndex < 0 ? "" : valueAndComment.slice(commentIndex);
    lines[defaultIndex] = { ...line, body: `${match[1]}${model}${trailingWhitespace}${comment}` };
  } else {
    const ending = detectLineEnding(lines);
    lines.splice(blockEnd, 0, { body: `${" ".repeat(defaultIndent)}default: ${model}`, ending });
  }
  const result = joinYamlLines(lines);
  verifyUpdatedModel(result, model);
  return result;
}

function updateInlineModel(inline: string, model: string): string {
  const inner = inline.slice(1, -1);
  const pattern = /(^|,\s*)(['"]?default['"]?)(\s*:\s*)([^,}]*?)(?=\s*(?:,|$))/;
  const match = inner.match(pattern);
  if (match && match.index !== undefined) {
    const start = match.index + match[1].length + match[2].length + match[3].length;
    const end = start + match[4].length;
    return `{${inner.slice(0, start)}${model}${inner.slice(end)}}`;
  }
  const separator = inner.trim() ? `${inner.trimEnd()}, ` : "";
  return `{${separator}default: ${model}}`;
}

function verifyUpdatedModel(source: string, model: string): void {
  const parsed = parseYaml(source);
  if (!isRecord(parsed) || !isRecord(parsed.modelRoles) || parsed.modelRoles.default !== model) {
    throw new Error("agent config modelRoles.default could not be updated");
  }
}

function validateModelName(value: string): string {
  const model = value.trim();
  const separator = model.indexOf("/");
  if (!model || separator <= 0 || separator === model.length - 1 || /\s/.test(model)) {
    throw new Error(`model '${value}' must use provider/model form`);
  }
  return model;
}

function rejectUnknownOptions(args: ParsedArguments, allowed: readonly string[]): void {
  for (const name of Object.keys(args.options)) {
    if (!allowed.includes(name)) throw new Error(`unknown option '--${name}'`);
  }
}

function printReferences(context: CommandContext, references: readonly string[]): void {
  for (const path of references) {
    context.io.stdout.write(`manual reference: ${path}\n`);
  }
}

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function stripYamlComment(value: string): string {
  const index = findYamlComment(value);
  return index < 0 ? value : value.slice(0, index);
}

function findYamlComment(value: string): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && character === "#" && (index === 0 || /\s/.test(value[index - 1]))) return index;
  }
  return -1;
}

function detectLineEnding(lines: readonly YamlTextLine[]): string {
  return lines.find((line) => line.ending)?.ending ?? "\n";
}
