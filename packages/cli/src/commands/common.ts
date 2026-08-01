import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentPath } from "../project.ts";
import { applyFilePlan, describeFilePlan } from "../file-plan.ts";
import type {
  CommandContext,
  FilePlan,
  ParsedArguments,
  ProjectContext,
} from "../types.ts";

export function assertAllowedOptions(
  args: ParsedArguments,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(args.options)) {
    if (!allowedSet.has(name)) throw new Error(`unknown option: --${name}`);
  }
}

export function requiredOptionString(
  args: ParsedArguments,
  name: string,
): string {
  const value = args.options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} requires a non-empty value`);
  }
  return value;
}

export async function assertPathAbsent(
  path: string,
  label: string,
): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing) throw new Error(`${label} already exists: ${path}`);
}

/** Reject agents that still keep their source in a legacy nested .omp layout. */
export async function assertNoLegacyOmpSource(
  agentPath: string,
  agentId: string,
): Promise<void> {
  const legacyOmpPath = join(agentPath, ".omp");
  const legacyOmpInfo = await lstat(legacyOmpPath).catch(() => null);
  if (legacyOmpInfo) {
    throw new Error(`agent '${agentId}' has a nested .omp directory; agent source must live at the agent root: ${agentPath}`);
  }
}

export async function requireAgent(
  project: ProjectContext,
  agentId: string,
): Promise<{ readonly path: string }> {
  const path = resolveAgentPath(project, agentId);
  const info = await lstat(path).catch(() => null);
  if (!info) throw new Error(`agent '${agentId}' does not exist: ${path}`);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`agent path is not a directory: ${path}`);
  }
  await assertNoLegacyOmpSource(path, agentId);
  return { path };
}

export async function applyAndReport(
  plan: FilePlan,
  context: CommandContext,
  dryRun: boolean,
): Promise<void> {
  await applyFilePlan(plan, { dryRun });
  for (const description of describeFilePlan(plan)) {
    context.io.stdout.write(`${dryRun ? "would " : ""}${description}\n`);
  }
}
