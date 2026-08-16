import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { optionBoolean } from "../args.ts";
import { applyFilePlan, createRemovePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, FilePlan, ParsedArguments } from "../types.ts";
import {
  assertNoSymlinkComponents,
  assertNoSymlinksRecursively,
  confirmDestructive,
  printPlan,
  relativePlanPath,
} from "./support.ts";

const DESTROY_HELP = [
  "omp-bundler destroy skill <name> [--dry-run] [--yes]",
  "omp-bundler destroy command <name> [--dry-run] [--yes]",
  "omp-bundler destroy tool <name> [--dry-run] [--yes]",
  "omp-bundler destroy extension <name> [--dry-run] [--yes]",
  "omp-bundler destroy subagent <name> [--dry-run] [--yes]",
  "omp-bundler destroy schedule <name> [--dry-run] [--yes]",
].join("\n");

const COMPONENT_DIRECTORY: Record<string, string> = {
  skill: "skills",
  command: "commands",
  tool: "tools",
  extension: "extensions",
  subagent: "subagents",
};

export const destroyCommand: CommandHandler = async (args, context) => {
  const kind = args.positionals[0];
  if (args.options.help === true || kind === undefined) {
    context.io.stdout.write(`${DESTROY_HELP}\n`);
    return 0;
  }
  if (kind && Object.hasOwn(COMPONENT_DIRECTORY, kind)) return destroyComponent(kind, args, context);
  if (kind === "schedule") return destroySchedule(args, context);
  throw new Error(`unknown destroy target '${kind ?? ""}'. Run 'omp-bundler destroy --help' for available commands`);
};

async function destroyComponent(
  kind: string,
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  for (const name of Object.keys(args.options)) {
    if (name !== "help" && name !== "dry-run" && name !== "yes") {
      throw new Error(`unknown option '--${name}'`);
    }
  }
  if (args.positionals.length !== 2) {
    throw new Error(`usage: omp-bundler destroy ${kind} <name> [--dry-run] [--yes]`);
  }
  const componentName = assertSafeIdentifier(args.positionals[1], "component name");
  const project = await loadProject(undefined, context.cwd);
  const componentDirectory = join(project.agent.path, COMPONENT_DIRECTORY[kind]);
  const componentPath = kind === "skill"
    ? join(componentDirectory, componentName, "SKILL.md")
    : join(componentDirectory, `${componentName}.${kind === "subagent" || kind === "command" ? "md" : "ts"}`);
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
  return executeDestruction(createRemovePlan(project.rootDir, paths), args, context);
}

async function executeDestruction(
  plan: FilePlan,
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  const dryRun = optionBoolean(args, "dry-run");
  printPlan(context, plan, dryRun);
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

async function destroySchedule(
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  for (const name of Object.keys(args.options)) {
    if (name !== "help" && name !== "dry-run" && name !== "yes") {
      throw new Error(`unknown option '--${name}'`);
    }
  }
  if (args.positionals.length !== 2) {
    throw new Error(`usage: omp-bundler destroy schedule <name> [--dry-run] [--yes]`);
  }
  const scheduleName = assertSafeIdentifier(args.positionals[1], "schedule name");
  const project = await loadProject(undefined, context.cwd);
  const schedulePath = join(project.rootDir, "schedules", `${scheduleName}.yml`);
  await assertNoSymlinkComponents(project.rootDir, schedulePath, "schedule path");
  const info = await lstat(schedulePath).catch(() => null);
  if (!info) throw new Error(`schedule '${scheduleName}' does not exist: ${schedulePath}`);
  if (info.isSymbolicLink()) throw new Error(`schedule path must not be a symlink: ${schedulePath}`);
  if (!info.isFile()) throw new Error(`schedule path is not a regular file: ${schedulePath}`);
  const plan = createRemovePlan(project.rootDir, [
    relativePlanPath(project.rootDir, schedulePath),
  ]);
  return executeDestruction(plan, args, context);
}
