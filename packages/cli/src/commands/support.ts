import type { Stats } from "node:fs";
import { createInterface } from "node:readline/promises";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { describeFilePlan } from "../file-plan.ts";
import type { CommandContext, FilePlan } from "../types.ts";


export interface OptionalTextFile {
  readonly path: string;
  readonly content: string;
}


export interface ReferenceScanOptions {
  readonly skip?: readonly string[];
  readonly filter?: (path: string, content: string) => boolean;
}

const MAX_REFERENCE_FILE_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "node_modules", "dist"]);

export async function assertNoSymlinkComponents(
  root: string,
  target: string,
  label: string,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const escaped = relative(resolvedRoot, resolvedTarget);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`${label} escapes project root: ${target}`);
  }

  let current = resolvedRoot;
  const rootInfo = await lstatOrNull(current);
  if (rootInfo?.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`);
  for (const segment of escaped ? escaped.split(sep) : []) {
    current = join(current, segment);
    const info = await lstatOrNull(current);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`);
  }
}

export async function assertNoSymlinksRecursively(
  target: string,
  label: string,
): Promise<void> {
  const info = await lstatOrNull(target);
  if (!info) throw new Error(`${label} does not exist: ${target}`);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${target}`);
  if (!info.isDirectory()) return;

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(target, entry.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink: ${child}`);
    }
    if (childInfo.isDirectory()) {
      await assertNoSymlinksRecursively(child, label);
    }
  }
}

export async function readOptionalTextFile(
  path: string,
  label: string,
): Promise<OptionalTextFile | null> {
  const info = await lstatOrNull(path);
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  return { path, content: await readFile(path, "utf8") };
}

export function relativePlanPath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`path is outside project root: ${path}`);
  }
  return value;
}


export async function findTextReferences(
  root: string,
  needle: string,
  options: ReferenceScanOptions = {},
): Promise<readonly string[]> {
  const skipped = new Set((options.skip ?? []).map((path) => resolve(path)));
  const references: string[] = [];
  await scanDirectory(resolve(root));
  return references;

  async function scanDirectory(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const resolvedPath = resolve(path);
      if ([...skipped].some((base) => resolvedPath === base || resolvedPath.startsWith(`${base}${sep}`))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await scanDirectory(path);
        continue;
      }
      if (!info.isFile() || info.size > MAX_REFERENCE_FILE_BYTES) continue;
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000") || !content.includes(needle)) continue;
      if (options.filter && !options.filter(path, content)) continue;
      references.push(path);
    }
  }
}

export function hasExactTextReference(content: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`).test(content);
}

export function printPlan(
  context: CommandContext,
  plan: FilePlan,
  dryRun: boolean,
): void {
  for (const description of describeFilePlan(plan)) {
    context.io.stdout.write(`${dryRun ? "dry-run: " : ""}${description}\n`);
  }
}

export async function confirmDestructive(
  context: CommandContext,
  yes: boolean,
): Promise<boolean> {
  if (yes) return true;
  const stdin = context.io.stdin as Readable & { isTTY?: boolean };
  if (stdin.isTTY !== true) {
    throw new Error("refusing non-interactive deletion; pass --yes to confirm");
  }
  const readline = createInterface({ input: context.io.stdin, output: context.io.stdout });
  try {
    const answer = await readline.question("Proceed? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
