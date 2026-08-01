import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
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
  const operations: FileOperation[] = [];
  const seen = new Set<string>();
  for (const write of writes) {
    const path = resolveInside(root, write.path);
    if (seen.has(path)) throw new Error(`file plan contains a duplicate path: ${write.path}`);
    seen.add(path);
    const overwrite = write.overwrite ?? options.overwrite ?? false;
    const existing = await lstat(path).catch(() => null);
    if (existing && !overwrite) throw new Error(`refusing to overwrite existing path: ${path}`);
    if (existing?.isDirectory()) throw new Error(`planned file path is a directory: ${path}`);
    operations.push({ kind: "write", path, content: write.content, overwrite, mode: write.mode });
  }
  return { operations };
}

export function createDirectoryPlan(
  root: string,
  paths: readonly string[],
): FilePlan {
  const seen = new Set<string>();
  const operations: FileOperation[] = [];
  for (const path of paths) {
    const resolvedPath = resolveInside(root, path);
    if (seen.has(resolvedPath)) throw new Error(`file plan contains a duplicate path: ${path}`);
    seen.add(resolvedPath);
    operations.push({ kind: "mkdir", path: resolvedPath });
  }
  return { operations };
}

export function createMovePlan(
  root: string,
  from: string,
  to: string,
): FilePlan {
  const source = resolveInside(root, from);
  const destination = resolveInside(root, to);
  if (source === destination) throw new Error("move source and destination must differ");
  return { operations: [{ kind: "move", from: source, to: destination }] };
}

export function createRemovePlan(
  root: string,
  paths: readonly string[],
): FilePlan {
  const seen = new Set<string>();
  const operations: FileOperation[] = [];
  for (const path of paths) {
    const resolvedPath = resolveInside(root, path);
    if (seen.has(resolvedPath)) throw new Error(`file plan contains a duplicate path: ${path}`);
    seen.add(resolvedPath);
    operations.push({ kind: "remove", path: resolvedPath });
  }
  return { operations };
}

export async function applyFilePlan(
  plan: FilePlan,
  options: ApplyFilePlanOptions = {},
): Promise<readonly string[]> {
  if (options.dryRun) return plan.operations.flatMap((operation) => operationPaths(operation));

  for (const operation of plan.operations) {
    if (operation.kind === "write" && !operation.overwrite) {
      const existing = await lstat(operation.path).catch(() => null);
      if (existing) throw new Error(`planned file appeared before write: ${operation.path}`);
    }
    if (operation.kind === "move") {
      const source = await lstat(operation.from).catch(() => null);
      if (!source) throw new Error(`move source does not exist: ${operation.from}`);
      const destination = await lstat(operation.to).catch(() => null);
      if (destination) throw new Error(`move destination already exists: ${operation.to}`);
    }
    if (operation.kind === "remove") {
      const existing = await lstat(operation.path).catch(() => null);
      if (!existing) throw new Error(`remove path does not exist: ${operation.path}`);
    }
  }

  const applied: string[] = [];
  for (const operation of plan.operations) {
    if (operation.kind === "mkdir") {
      await mkdir(operation.path, { recursive: true });
      applied.push(operation.path);
    } else if (operation.kind === "write") {
      await mkdir(resolve(operation.path, ".."), { recursive: true });
      await writeFile(operation.path, operation.content, {
        encoding: typeof operation.content === "string" ? "utf8" : undefined,
        flag: operation.overwrite ? "w" : "wx",
        mode: operation.mode,
      });
      applied.push(operation.path);
    } else if (operation.kind === "move") {
      await mkdir(resolve(operation.to, ".."), { recursive: true });
      await rename(operation.from, operation.to);
      applied.push(operation.to);
    } else {
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
