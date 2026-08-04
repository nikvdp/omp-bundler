import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { optionBoolean } from "../args.ts";
import { applyFilePlan, createFilePlan, createRemovePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { modelConfigPath } from "../model-config.ts";
import { loadProject, resolveAgentPath } from "../project.ts";
import type { CommandContext, CommandHandler, FilePlan, ParsedArguments } from "../types.ts";
import { assertNoLegacyOmpSource } from "./common.ts";
import {
  assertNoSymlinkComponents,
  assertNoSymlinksRecursively,
  confirmDestructive,
  findTextReferences,
  hasExactTextReference,
  printPlan,
  readOptionalTextFile,
  relativePlanPath,
  transformPumbleAgentBinding,
} from "./support.ts";
import {
  PUMBLE_ENV_HEADING,
  removePumbleBlock,
  setBundledAdapter,
  updateAgentModelEnvBlock,
} from "./templates.ts";

const DESTROY_HELP = [
  "omp-bundler destroy agent <agent-id> [--dry-run] [--yes]",
  "omp-bundler destroy skill <agent-id> <name> [--dry-run] [--yes]",
  "omp-bundler destroy command <agent-id> <name> [--dry-run] [--yes]",
  "omp-bundler destroy tool <agent-id> <name> [--dry-run] [--yes]",
  "omp-bundler destroy extension <agent-id> <name> [--dry-run] [--yes]",
  "omp-bundler destroy subagent <agent-id> <name> [--dry-run] [--yes]",
].join("\n");

const COMPONENT_DIRECTORY: Record<string, string> = {
  skill: "skills",
  command: "commands",
  tool: "tools",
  extension: "extensions",
  subagent: "agents",
};

export const destroyCommand: CommandHandler = async (args, context) => {
  const kind = args.positionals[0];
  if (args.options.help === true || kind === undefined) {
    context.io.stdout.write(`${DESTROY_HELP}\n`);
    return 0;
  }
  if (kind === "agent") return destroyAgent(args, context);
  if (kind && Object.hasOwn(COMPONENT_DIRECTORY, kind)) return destroyComponent(kind, args, context);
  throw new Error(`unknown destroy target '${kind ?? ""}'. Run 'omp-bundler destroy --help' for available commands`);
};

async function destroyComponent(
  kind: string,
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  rejectUnknownOptions(args);
  if (args.positionals.length !== 3) {
    throw new Error(`usage: omp-bundler destroy ${kind} <agent-id> <name> [--dry-run] [--yes]`);
  }
  const agentId = assertSafeIdentifier(args.positionals[1], "agent id");
  const componentName = assertSafeIdentifier(args.positionals[2], "component name");
  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");
  const agentPath = resolveAgentPath(project, agentId);
  await assertNoSymlinkComponents(project.agentsDir, agentPath, "agent path");
  const agentInfo = await lstat(agentPath).catch(() => null);
  if (!agentInfo) throw new Error(`agent '${agentId}' does not exist: ${agentPath}`);
  if (agentInfo.isSymbolicLink()) throw new Error(`agent path must not be a symlink: ${agentPath}`);
  if (!agentInfo.isDirectory()) throw new Error(`agent path is not a directory: ${agentPath}`);
  await assertNoLegacyOmpSource(agentPath, agentId);

  const componentDirectory = join(agentPath, COMPONENT_DIRECTORY[kind]);
  const componentPath = kind === "skill"
    ? join(componentDirectory, componentName, "SKILL.md")
    : join(componentDirectory, `${componentName}.${kind === "subagent" ? "md" : kind === "command" ? "md" : "ts"}`);
  await assertNoSymlinkComponents(project.rootDir, componentPath, `${kind} path`);
  const componentInfo = await lstat(componentPath).catch(() => null);
  if (!componentInfo) throw new Error(`${kind} '${componentName}' does not exist: ${componentPath}`);
  if (componentInfo.isSymbolicLink()) throw new Error(`${kind} path must not be a symlink: ${componentPath}`);
  if (kind === "skill") {
    if (!componentInfo.isFile()) throw new Error(`skill path is not a regular file: ${componentPath}`);
    await assertNoSymlinksRecursively(join(componentDirectory, componentName), "skill path");
  } else if (!componentInfo.isFile()) {
    throw new Error(`${kind} path is not a regular file: ${componentPath}`);
  }

  const paths = [relativePlanPath(project.rootDir, componentPath)];
  if (kind === "skill") {
    const skillDirectory = join(componentDirectory, componentName);
    const entries = await readdir(skillDirectory, { withFileTypes: true });
    if (entries.length === 1 && entries[0].name === basename(componentPath)) {
      paths.push(relativePlanPath(project.rootDir, skillDirectory));
    }
  }
  const plan = createRemovePlan(project.rootDir, paths);
  return executeDestruction(plan, args, context);
}

async function destroyAgent(
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  rejectUnknownOptions(args);
  if (args.positionals.length !== 2) {
    throw new Error("usage: omp-bundler destroy agent <agent-id> [--dry-run] [--yes]");
  }
  const agentId = assertSafeIdentifier(args.positionals[1], "agent id");
  const project = await loadProject(undefined, context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");
  const agentPath = resolveAgentPath(project, agentId);
  await assertNoSymlinkComponents(project.agentsDir, agentPath, "agent source");
  const agentInfo = await lstat(agentPath).catch(() => null);
  if (!agentInfo) throw new Error(`agent '${agentId}' does not exist: ${agentPath}`);
  if (agentInfo.isSymbolicLink()) throw new Error(`agent source must not be a symlink: ${agentPath}`);
  if (!agentInfo.isDirectory()) throw new Error(`agent source is not a directory: ${agentPath}`);
  await assertNoSymlinksRecursively(agentPath, "agent source");
  await assertNoLegacyOmpSource(agentPath, agentId);

  const envExamplePath = join(project.rootDir, "runtime.env.example");
  const envExample = await readOptionalTextFile(envExamplePath, "runtime.env.example");
  let envContent = envExample?.content ?? null;
  if (envContent !== null) {
    const hadManagedPumbleBlock = envContent.includes(PUMBLE_ENV_HEADING);
    const withoutManagedPumble = removePumbleBlock(envContent, agentId);
    const removedManagedPumble = withoutManagedPumble !== envContent;
    const pumbleChange = transformPumbleAgentBinding(withoutManagedPumble, agentId, null);
    envContent = pumbleChange.changed ? pumbleChange.content : withoutManagedPumble;
    if (removedManagedPumble || (pumbleChange.changed && !hadManagedPumbleBlock)) {
      envContent = setBundledAdapter(envContent, "http");
    }
    envContent = updateAgentModelEnvBlock(envContent, agentId, []);
  }
  const envChange = envExample && envContent !== null
    ? { changed: envContent !== envExample.content, content: envContent }
    : null;
  const modelPath = modelConfigPath(project, agentId);
  await assertNoSymlinkComponents(project.rootDir, modelPath, "model source");
  const modelInfo = await lstat(modelPath).catch(() => null);
  if (modelInfo?.isSymbolicLink()) throw new Error(`model source must not be a symlink: ${modelPath}`);
  if (modelInfo && !modelInfo.isFile()) throw new Error(`model source is not a regular file: ${modelPath}`);
  const references = await findTextReferences(project.rootDir, agentId, {
    skip: [agentPath, modelPath],
    filter: (path, content) => {
      const candidate = path === envExamplePath && envChange?.changed ? envChange.content : content;
      return hasExactTextReference(candidate, agentId);
    },
  });

  const removePaths = [relativePlanPath(project.rootDir, agentPath)];
  if (modelInfo) removePaths.push(relativePlanPath(project.rootDir, modelPath));
  const removePlan = createRemovePlan(project.rootDir, removePaths);
  const operations = [...removePlan.operations];
  if (envExample && envChange?.changed) {
    const envPlan = await createFilePlan(project.rootDir, [{
      path: relativePlanPath(project.rootDir, envExamplePath),
      content: envChange.content,
      overwrite: true,
    }]);
    operations.push(...envPlan.operations);
  }
  return executeDestruction({ root: removePlan.root, operations }, args, context, references);
}

async function executeDestruction(
  plan: FilePlan,
  args: ParsedArguments,
  context: CommandContext,
  references: readonly string[] = [],
): Promise<number> {
  const dryRun = optionBoolean(args, "dry-run");
  printPlan(context, plan, dryRun);
  for (const path of references) context.io.stdout.write(`manual reference: ${path}\n`);
  if (dryRun) {
    await applyFilePlan(plan, { dryRun: true });
    return 0;
  }
  const confirmed = await confirmDestructive(context, optionBoolean(args, "yes"));
  if (!confirmed) {
    context.io.stdout.write("cancelled\n");
    return 0;
  }
  await applyFilePlan(plan);
  return 0;
}

function rejectUnknownOptions(args: ParsedArguments): void {
  for (const name of Object.keys(args.options)) {
    if (name !== "help" && name !== "dry-run" && name !== "yes") {
      throw new Error(`unknown option '--${name}'`);
    }
  }
}
