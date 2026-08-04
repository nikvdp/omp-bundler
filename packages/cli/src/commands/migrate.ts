import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { optionBoolean } from "../args.ts";
import { applyFilePlan, createMovePlan, createRemovePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, FileOperation, FilePlan, ParsedArguments } from "../types.ts";
import {
  assertNoSymlinkComponents,
  assertNoSymlinksRecursively,
  confirmDestructive,
  printPlan,
  relativePlanPath,
} from "./support.ts";

const MIGRATE_HELP = [
  "omp-bundler migrate visible-layout [bundle-path] [--dry-run] [--yes]",
].join("\n");

const LEGACY_OMP = ".omp";

export const migrateCommand: CommandHandler = async (args, context) => {
  const form = args.positionals[0];
  if (args.options.help === true || form === undefined) {
    context.io.stdout.write(`${MIGRATE_HELP}\n`);
    return 0;
  }
  if (form !== "visible-layout") {
    throw new Error(`unknown migrate target '${form ?? ""}'. Run 'omp-bundler migrate --help' for available commands`);
  }
  return migrateVisibleLayout(args, context);
};

async function migrateVisibleLayout(
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  rejectUnknownOptions(args);
  if (args.positionals.length > 2) {
    throw new Error(`usage: ${MIGRATE_HELP}`);
  }
  const project = await loadProject(args.positionals[1], context.cwd);
  await assertNoSymlinkComponents(project.rootDir, project.agentsDir, "agents directory");
  const agentsDirInfo = await lstat(project.agentsDir).catch((error: unknown) => {
    throw new Error(`agents directory '${project.agentsDir}' is not accessible: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!agentsDirInfo.isDirectory()) throw new Error(`agents path is not a directory: ${project.agentsDir}`);

  const entries = await readdir(project.agentsDir, { withFileTypes: true });
  const operations: FileOperation[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".gitkeep") continue;
    assertSafeIdentifier(entry.name, "agent id");
    const agentPath = join(project.agentsDir, entry.name);
    const agentInfo = await lstat(agentPath);
    if (agentInfo.isSymbolicLink()) throw new Error(`agent path must not be a symlink: ${agentPath}`);
    if (!agentInfo.isDirectory()) throw new Error(`agent collection entry is not a directory: ${agentPath}`);
    await assertNoSymlinkComponents(project.agentsDir, agentPath, "agent path");

    const ompPath = join(agentPath, LEGACY_OMP);
    const ompInfo = await lstat(ompPath).catch(() => null);
    if (!ompInfo) continue; // already migrated; nothing to do
    if (ompInfo.isSymbolicLink()) throw new Error(`legacy ${LEGACY_OMP} must not be a symlink: ${ompPath}`);
    if (!ompInfo.isDirectory()) throw new Error(`legacy ${LEGACY_OMP} is not a directory: ${ompPath}`);
    await assertNoSymlinkComponents(agentPath, ompPath, "legacy .omp path");
    await assertNoSymlinksRecursively(ompPath, "legacy .omp path");

    const children = await readdir(ompPath, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === ".gitkeep") continue;
      const source = join(ompPath, child.name);
      const destination = join(agentPath, child.name);
      const destinationInfo = await lstat(destination).catch(() => null);
      if (destinationInfo) {
        throw new Error(`refusing to overwrite existing agent surface path: ${destination}`);
      }
      operations.push(...createMovePlan(
        project.rootDir,
        relativePlanPath(project.rootDir, source),
        relativePlanPath(project.rootDir, destination),
      ).operations);
    }
    operations.push(...createRemovePlan(project.rootDir, [relativePlanPath(project.rootDir, ompPath)]).operations);
  }

  const plan: FilePlan = { root: project.rootDir, operations };
  if (plan.operations.length === 0) {
    context.io.stdout.write("nothing to migrate: no legacy .omp agent layouts found\n");
    return 0;
  }
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

function rejectUnknownOptions(args: ParsedArguments): void {
  for (const name of Object.keys(args.options)) {
    if (name !== "help" && name !== "dry-run" && name !== "yes") {
      throw new Error(`unknown option '--${name}'`);
    }
  }
}
