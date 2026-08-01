import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveInside } from "./identifiers.ts";
import type {
  FileOperation,
  FilePlan,
  PlannedWrite,
} from "./types.ts";

export interface FilePlanOptions {
  readonly overwrite?: boolean;
}

export interface ApplyFilePlanOptions {
  readonly dryRun?: boolean;
}
export async function createFilePlan(
  root: string,
  writes: readonly PlannedWrite[],
  options: FilePlanOptions = {},
): Promise<FilePlan> {
  const planRoot = resolve(root);
  const operations: FileOperation[] = [];
  const seen = new Set<string>();
  for (const write of writes) {
    const path = resolveInside(planRoot, write.path);
    if (seen.has(path)) throw new Error(`file plan contains a duplicate path: ${write.path}`);
    seen.add(path);
    await assertNoSymlinkComponents(path, planRoot);
    const overwrite = write.overwrite ?? options.overwrite ?? false;
    const existing = await lstatIfPresent(path);
    if (existing && !overwrite) throw new Error(`refusing to overwrite existing path: ${path}`);
    if (existing?.isDirectory()) throw new Error(`planned file path is a directory: ${path}`);
    operations.push({ kind: "write", path, content: write.content, overwrite, mode: write.mode });
  }
  return { root: planRoot, operations };
}
export function createDirectoryPlan(
  root: string,
  paths: readonly string[],
): FilePlan {
  const planRoot = resolve(root);
  const seen = new Set<string>();
  const operations: FileOperation[] = [];
  for (const path of paths) {
    const resolvedPath = resolveInside(planRoot, path);
    if (seen.has(resolvedPath)) throw new Error(`file plan contains a duplicate path: ${path}`);
    seen.add(resolvedPath);
    assertNoSymlinkComponentsSync(resolvedPath, planRoot);
    operations.push({ kind: "mkdir", path: resolvedPath });
  }
  return { root: planRoot, operations };
}
export function createMovePlan(
  root: string,
  from: string,
  to: string,
): FilePlan {
  const planRoot = resolve(root);
  const source = resolveInside(planRoot, from);
  const destination = resolveInside(planRoot, to);
  if (source === destination) throw new Error("move source and destination must differ");
  assertNoSymlinkComponentsSync(source, planRoot);
  assertNoSymlinkComponentsSync(destination, planRoot);
  return { root: planRoot, operations: [{ kind: "move", from: source, to: destination }] };
}
export function createRemovePlan(
  root: string,
  paths: readonly string[],
): FilePlan {
  const planRoot = resolve(root);
  const seen = new Set<string>();
  const operations: FileOperation[] = [];
  for (const path of paths) {
    const resolvedPath = resolveInside(planRoot, path);
    if (seen.has(resolvedPath)) throw new Error(`file plan contains a duplicate path: ${path}`);
    seen.add(resolvedPath);
    assertNoSymlinkComponentsSync(resolvedPath, planRoot);
    operations.push({ kind: "remove", path: resolvedPath });
  }
  return { root: planRoot, operations };
}

export async function applyFilePlan(
  plan: FilePlan,
  options: ApplyFilePlanOptions = {},
): Promise<readonly string[]> {
  if (options.dryRun) return plan.operations.flatMap((operation) => operationPaths(operation));

  for (const operation of plan.operations) {
    await assertOperationSafe(operation, plan.root);
    if (operation.kind === "write" && !operation.overwrite) {
      const existing = await lstatIfPresent(operation.path);
      if (existing) throw new Error(`planned file appeared before write: ${operation.path}`);
    }
    if (operation.kind === "move") {
      const source = await lstatIfPresent(operation.from);
      if (!source) throw new Error(`move source does not exist: ${operation.from}`);
      const destination = await lstatIfPresent(operation.to);
      if (destination) throw new Error(`move destination already exists: ${operation.to}`);
    }
    if (operation.kind === "remove") {
      const existing = await lstatIfPresent(operation.path);
      if (!existing) throw new Error(`remove path does not exist: ${operation.path}`);
    }
  }

  const applied: string[] = [];
  for (const operation of plan.operations) {
    if (operation.kind === "mkdir") {
      await assertOperationSafe(operation, plan.root);
      await mkdir(operation.path, { recursive: true });
      applied.push(operation.path);
    } else if (operation.kind === "write") {
      await assertOperationSafe(operation, plan.root);
      await mkdir(dirname(operation.path), { recursive: true });
      await assertOperationSafe(operation, plan.root);
      await writeFile(operation.path, operation.content, {
        encoding: typeof operation.content === "string" ? "utf8" : undefined,
        flag: operation.overwrite ? "w" : "wx",
        mode: operation.mode,
      });
      applied.push(operation.path);
    } else if (operation.kind === "move") {
      await assertOperationSafe(operation, plan.root);
      await mkdir(dirname(operation.to), { recursive: true });
      await assertOperationSafe(operation, plan.root);
      await rename(operation.from, operation.to);
      applied.push(operation.to);
    } else {
      await assertOperationSafe(operation, plan.root);
      await rm(operation.path, { recursive: true, force: false });
      applied.push(operation.path);
    }
  }
  return applied;
}

export function describeFilePlan(plan: FilePlan): string[] {
  return plan.operations.flatMap((operation) => {
    if (operation.kind === "write") return [`${operation.overwrite ? "update" : "create"} ${operation.path}`];
    if (operation.kind === "mkdir") return [`create directory ${operation.path}`];
    if (operation.kind === "move") return [`move ${operation.from} -> ${operation.to}`];
    return [`remove ${operation.path}`];
  });
}

function operationPaths(operation: FileOperation): string[] {
  if (operation.kind === "move") return [operation.from, operation.to];
  return [operation.path];
}

async function assertOperationSafe(operation: FileOperation, root: string): Promise<void> {
  if (operation.kind === "move") {
    await assertNoSymlinkComponents(operation.from, root);
    await assertNoSymlinkComponents(operation.to, root);
    return;
  }
  await assertNoSymlinkComponents(operation.path, root);
}

async function assertNoSymlinkComponents(path: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assertInside(resolvedRoot, resolvedPath);
  let current = resolvedPath;
  while (true) {
    const info = await lstatIfPresent(current);
    if (info?.isSymbolicLink()) throw symlinkMutationError(current);
    if (current === resolvedRoot) break;
    current = dirname(current);
  }
  if (await lstatIfPresent(resolvedRoot)) return;
  current = dirname(resolvedRoot);
  while (true) {
    const info = await lstatIfPresent(current);
    if (info) {
      if (info.isSymbolicLink()) throw symlinkMutationError(current);
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertNoSymlinkComponentsSync(path: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assertInside(resolvedRoot, resolvedPath);
  let current = resolvedPath;
  while (true) {
    let info: Stats | undefined;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (info?.isSymbolicLink()) throw symlinkMutationError(current);
    if (current === resolvedRoot) break;
    current = dirname(current);
  }
  let rootInfo: Stats | undefined;
  try {
    rootInfo = lstatSync(resolvedRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (rootInfo) return;
  current = dirname(resolvedRoot);
  while (true) {
    let info: Stats | undefined;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (info) {
      if (info.isSymbolicLink()) throw symlinkMutationError(current);
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertInside(root: string, path: string): void {
  const escaped = relative(root, path);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`planned path escapes project root: ${path}`);
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function symlinkMutationError(path: string): Error {
  return new Error(`refusing to mutate through symlinked path component: ${path}`);
}
