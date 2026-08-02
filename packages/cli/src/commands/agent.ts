import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { optionBoolean } from "../args.ts";
import { applyFilePlan, createFilePlan, createMovePlan } from "../file-plan.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { loadProject, resolveAgentPath } from "../project.ts";
import type { CommandContext, CommandHandler, FilePlan, ParsedArguments } from "../types.ts";
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

const AGENT_HELP = "omp-bundler agent rename <old-agent-id> <new-agent-id>";

export const agentCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${AGENT_HELP}\n`);
    return 0;
  }
  const subcommand = args.positionals[0];
  if (subcommand === "rename") return agentRename(args, context);
  throw new Error(`unknown agent subcommand '${subcommand ?? ""}'. Run 'omp-bundler agent --help' for available commands`);
};

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
