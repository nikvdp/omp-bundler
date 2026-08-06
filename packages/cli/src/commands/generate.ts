import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { assertSafeIdentifier } from "../identifiers.ts";
import { createFilePlan } from "../file-plan.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";
import {
  applyAndReport,
  assertAllowedOptions,
} from "./common.ts";
import { assertNoSymlinkComponents } from "./support.ts";
import { componentFile, scheduleFile, updatePumbleBlock } from "./templates.ts";
import type { ComponentKind } from "./templates.ts";

const GENERATE_HELP = [
  "omp-bundler generate skill <name> [--dry-run]",
  "omp-bundler generate command <name> [--dry-run]",
  "omp-bundler generate tool <name> [--dry-run]",
  "omp-bundler generate extension <name> [--dry-run]",
  "omp-bundler generate subagent <name> [--dry-run]",
  "omp-bundler generate adapter pumble [--dry-run]",
  "omp-bundler generate schedule <name> [--dry-run]",
].join("\n");

const COMPONENT_KINDS: Record<string, ComponentKind> = {
  skill: "skill",
  command: "command",
  tool: "tool",
  extension: "extension",
  subagent: "subagent",
};

export const generateCommand: CommandHandler = async (args, context) => {
  const kind = args.positionals[0];
  if (args.options.help === true || kind === undefined) {
    context.io.stdout.write(`${GENERATE_HELP}\n`);
    return 0;
  }
  assertAllowedOptions(args, ["dry-run"]);
  const dryRun = args.options["dry-run"] === true;
  if (kind === "adapter") return generateAdapter(args, context, dryRun);
  if (kind === "schedule") return generateSchedule(args, context, dryRun);
  const componentKind = COMPONENT_KINDS[kind];
  if (componentKind === undefined) {
    throw new Error(`usage: omp-bundler generate <skill|command|tool|extension|subagent|adapter|schedule> ...`);
  }
  return generateComponent(args, context, componentKind, dryRun);
};

async function generateComponent(
  args: ParsedArguments,
  context: CommandContext,
  kind: ComponentKind,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 2) {
    throw new Error(`usage: omp-bundler generate ${kind} <name> [--dry-run]`);
  }
  const name = args.positionals[1];
  assertSafeIdentifier(name, `${kind} name`);
  const project = await loadProject(undefined, context.cwd);
  const path = join(project.agent.path, componentFile(kind, name).path);
  await assertNoSymlinkComponents(project.rootDir, path, `${kind} path`);
  const plan = await createFilePlan(project.rootDir, [componentFile(kind, name)]);
  await applyAndReport(plan, context, dryRun);
}

async function generateAdapter(
  args: ParsedArguments,
  context: CommandContext,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 2 || args.positionals[1] !== "pumble") {
    throw new Error("usage: omp-bundler generate adapter pumble [--dry-run]");
  }
  const project = await loadProject(undefined, context.cwd);
  const runtimePath = join(project.rootDir, "runtime.env.example");
  await assertNoSymlinkComponents(project.rootDir, runtimePath, "runtime.env.example");
  const source = await readFile(runtimePath, "utf8").catch((error: unknown) => {
    throw new Error(`cannot read runtime.env.example '${runtimePath}': ${error instanceof Error ? error.message : String(error)}`);
  });
  const merged = updatePumbleBlock(source);
  if (merged === source) {
    context.io.stdout.write(`no changes ${runtimePath}\n`);
    return;
  }
  const plan = await createFilePlan(project.rootDir, [
    { path: "runtime.env.example", content: merged, overwrite: true },
  ]);
  await applyAndReport(plan, context, dryRun);
}

async function generateSchedule(
  args: ParsedArguments,
  context: CommandContext,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 2) {
    throw new Error(`usage: omp-bundler generate schedule <name> [--dry-run]`);
  }
  const name = args.positionals[1];
  assertSafeIdentifier(name, "schedule name");
  const project = await loadProject(undefined, context.cwd);
  const path = join(project.rootDir, `schedules/${name}.yml`);
  await assertNoSymlinkComponents(project.rootDir, path, "schedule path");
  const plan = await createFilePlan(project.rootDir, [scheduleFile(name)]);
  await applyAndReport(plan, context, dryRun);
}
