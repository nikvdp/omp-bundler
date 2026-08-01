import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeIdentifier } from "../identifiers.ts";
import { createFilePlan, createRemovePlan } from "../file-plan.ts";
import { loadProject } from "../project.ts";
import type {
  CommandContext,
  CommandHandler,
  FilePlan,
  ParsedArguments,
} from "../types.ts";
import {
  applyAndReport,
  assertAllowedOptions,
  assertPathAbsent,
  requireAgent,
  requiredOptionString,
} from "./common.ts";
import {
  agentScaffoldFiles,
  componentFile,
  PUMBLE_RUNTIME_FIELDS,
} from "./templates.ts";
import type { ComponentKind } from "./templates.ts";

const COMPONENT_KINDS: Record<string, ComponentKind> = {
  skill: "skill",
  command: "command",
  tool: "tool",
  extension: "extension",
  subagent: "subagent",
};

export const generateCommand: CommandHandler = async (args, context) => {
  assertAllowedOptions(args, ["agent", "dry-run"]);
  const kind = args.positionals[0];
  const dryRun = args.options["dry-run"] === true;
  if (kind === "adapter") {
    return generateAdapter(args, context, dryRun);
  }
  if (kind === "agent") {
    if (args.options.agent !== undefined) {
      throw new Error("generate agent takes the agent id as a positional argument");
    }
    return generateAgent(args, context, dryRun);
  }
  const componentKind = kind === undefined ? undefined : COMPONENT_KINDS[kind];
  if (componentKind === undefined) {
    throw new Error(
      "usage: omp-bundler generate <agent|skill|command|tool|extension|subagent|adapter> ...",
    );
  }
  if (args.options.agent !== undefined) {
    throw new Error(`generate ${kind} takes the agent id as a positional argument`);
  }
  return generateComponent(args, context, componentKind, dryRun);
};

async function generateAgent(
  args: ParsedArguments,
  context: CommandContext,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 2) {
    throw new Error("usage: omp-bundler generate agent <agent-id> [--dry-run]");
  }
  const agentId = args.positionals[1];
  assertSafeIdentifier(agentId, "agent id");
  const project = await loadProject(undefined, context.cwd);
  const agentPath = join(project.agentsDir, agentId);
  await assertPathAbsent(agentPath, "agent destination");

  const writes = agentScaffoldFiles(agentId).map((write) => ({
    path: join(agentId, write.path),
    content: write.content,
  }));
  const scaffoldPlan = await createFilePlan(project.agentsDir, writes);
  const placeholder = join(project.agentsDir, ".gitkeep");
  const placeholderInfo = await lstat(placeholder).catch(() => null);
  const operations = [...scaffoldPlan.operations];
  if (placeholderInfo) {
    if (!placeholderInfo.isFile()) {
      throw new Error(`refusing to remove non-file agent placeholder: ${placeholder}`);
    }
    operations.push(...createRemovePlan(project.agentsDir, [".gitkeep"]).operations);
  }
  await applyAndReport({ root: scaffoldPlan.root, operations } satisfies FilePlan, context, dryRun);
}

async function generateComponent(
  args: ParsedArguments,
  context: CommandContext,
  kind: ComponentKind,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 3) {
    throw new Error(`usage: omp-bundler generate ${kind} <agent-id> <name> [--dry-run]`);
  }
  const agentId = args.positionals[1];
  const name = args.positionals[2];
  assertSafeIdentifier(agentId, "agent id");
  assertSafeIdentifier(name, `${kind} name`);
  const project = await loadProject(undefined, context.cwd);
  const agent = await requireAgent(project, agentId);
  const plan = await createFilePlan(agent.path, [componentFile(kind, name)]);
  await applyAndReport(plan, context, dryRun);
}

async function generateAdapter(
  args: ParsedArguments,
  context: CommandContext,
  dryRun: boolean,
): Promise<void> {
  if (args.positionals.length !== 2) {
    throw new Error("usage: omp-bundler generate adapter pumble --agent <agent-id> [--dry-run]");
  }
  if (args.positionals[1] !== "pumble") {
    throw new Error(`unsupported adapter '${args.positionals[1]}'; expected pumble`);
  }
  const agentId = requiredOptionString(args, "agent");
  assertSafeIdentifier(agentId, "agent id");
  const project = await loadProject(undefined, context.cwd);
  await requireAgent(project, agentId);

  const runtimePath = join(project.rootDir, "runtime.env.example");
  let source: string;
  try {
    source = await readFile(runtimePath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read runtime.env.example '${runtimePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const merged = mergePumbleFields(source, agentId);
  if (merged === source) {
    context.io.stdout.write(`no changes ${runtimePath}\n`);
    return;
  }
  const plan = await createFilePlan(project.rootDir, [
    { path: "runtime.env.example", content: merged, overwrite: true },
  ]);
  await applyAndReport(plan, context, dryRun);
}

function mergePumbleFields(source: string, agentId: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let changed = false;
  const additions: string[] = [];
  const fields = [...PUMBLE_RUNTIME_FIELDS, "PUMBLE_AGENT_ID"] as const;

  for (const field of fields) {
    const matches: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (envAssignment(lines[index], field) !== undefined) matches.push(index);
    }
    if (field === "PUMBLE_AGENT_ID") {
      const bindings = matches
        .map((index) => envAssignment(lines[index], field)?.trim() ?? "")
        .filter((value) => value.length > 0);
      const conflict = bindings.find((value) => value !== agentId);
      if (conflict !== undefined) {
        throw new Error(
          `runtime.env.example already binds PUMBLE_AGENT_ID to '${conflict}'; change or remove that binding explicitly`,
        );
      }
      if (matches.length === 0) {
        additions.push(`${field}=${agentId}`);
      } else {
        for (const index of matches) {
          if ((envAssignment(lines[index], field) ?? "").trim() === "") {
            lines[index] = replaceEnvAssignment(lines[index], agentId);
            changed = true;
          }
        }
      }
    } else if (matches.length === 0) {
      additions.push(`${field}=`);
    }
  }

  if (additions.length > 0) {
    let updated = lines.join(eol);
    if (updated.length > 0 && !updated.endsWith(eol)) updated += eol;
    updated += additions.join(eol) + eol;
    return updated;
  }
  return changed ? lines.join(eol) : source;
}

function envAssignment(line: string, field: string): string | undefined {
  const prefix = new RegExp(`^\\s*${field}\\s*=`);
  if (!prefix.test(line)) return undefined;
  return line.slice(line.indexOf("=") + 1);
}

function replaceEnvAssignment(line: string, value: string): string {
  return `${line.slice(0, line.indexOf("=") + 1)}${value}`;
}
