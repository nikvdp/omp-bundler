import { lstat } from "node:fs/promises";
import { applyFilePlan, describeFilePlan } from "../file-plan.ts";
import type {
  CommandContext,
  FilePlan,
  ParsedArguments,
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
