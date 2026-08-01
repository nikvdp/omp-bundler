import { constants as fsConstants, lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

  await preflightFilePlan(plan);
  const artifacts: TransactionArtifact[] = [];
  const createdDirectories = new Set<string>();
  const undoStack: UndoOperation[] = [];
  let applied: string[] = [];
  try {
    const stagedWrites = await stageWrites(plan, artifacts, createdDirectories);
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      if (operation.kind === "mkdir") {
        await applyMkdirOperation(operation, plan.root, createdDirectories, undoStack);
      } else if (operation.kind === "write") {
        await applyWriteOperation(
          operation,
          stagedWrites.get(index),
          plan.root,
          artifacts,
          createdDirectories,
          undoStack,
        );
      } else if (operation.kind === "move") {
        await applyMoveOperation(operation, plan.root, artifacts, createdDirectories, undoStack);
      } else {
        await applyRemoveOperation(operation, plan.root, artifacts, undoStack);
      }
      applied.push(operation.kind === "move" ? operation.to : operation.path);
    }
  } catch (error) {
    const rollbackErrors = await rollback(undoStack);
    rollbackErrors.push(...await cleanupArtifacts(artifacts, plan.root, false));
    rollbackErrors.push(...await cleanupCreatedDirectories(createdDirectories, plan.root));
    if (rollbackErrors.length > 0) throw withRollbackContext(error, rollbackErrors);
    throw error;
  }

  const cleanupErrors = await cleanupArtifacts(artifacts, plan.root, true);
  if (cleanupErrors.length > 0) {
    throw new Error(`file plan committed but cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
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

type UndoOperation = () => Promise<void>;

interface TransactionArtifact {
  path: string;
  readonly kind: "stage" | "backup";
  cleanupOnSuccess: boolean;
  cleanupOnFailure: boolean;
}

interface StagedWrite {
  readonly artifact: TransactionArtifact;
}

interface WriteUndoState {
  targetInstalled: boolean;
  backup: TransactionArtifact | undefined;
  backupMoved: boolean;
}

const TRANSACTION_PREFIX = ".omp-bundler-txn-";

async function preflightFilePlan(plan: FilePlan): Promise<void> {
  for (const operation of plan.operations) {
    await assertOperationSafe(operation, plan.root);
    if (operation.kind === "write") {
      const existing = await lstatIfPresent(operation.path);
      if (existing && !operation.overwrite) {
        throw new Error(`planned file appeared before write: ${operation.path}`);
      }
      if (existing?.isDirectory()) {
        throw new Error(`planned file path is a directory: ${operation.path}`);
      }
    } else if (operation.kind === "move") {
      const source = await lstatIfPresent(operation.from);
      if (!source) throw new Error(`move source does not exist: ${operation.from}`);
      const destination = await lstatIfPresent(operation.to);
      if (destination) throw new Error(`move destination already exists: ${operation.to}`);
    } else if (operation.kind === "remove") {
      const existing = await lstatIfPresent(operation.path);
      if (!existing) throw new Error(`remove path does not exist: ${operation.path}`);
    }
  }
}

async function stageWrites(
  plan: FilePlan,
  artifacts: TransactionArtifact[],
  createdDirectories: Set<string>,
): Promise<Map<number, StagedWrite>> {
  const stagedWrites = new Map<number, StagedWrite>();
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    if (operation.kind !== "write") continue;
    await assertOperationSafe(operation, plan.root);
    const existing = await lstatIfPresent(operation.path);
    if (existing?.isDirectory()) throw new Error(`planned file path is a directory: ${operation.path}`);
    if (existing && !operation.overwrite) {
      throw new Error(`planned file appeared before write: ${operation.path}`);
    }
    await ensureDirectory(dirname(operation.path), plan.root, createdDirectories);
    await assertOperationSafe(operation, plan.root);
    const stagePath = await uniqueSiblingPath(operation.path, "stage", plan.root);
    const artifact: TransactionArtifact = {
      path: stagePath,
      kind: "stage",
      cleanupOnSuccess: true,
      cleanupOnFailure: true,
    };
    await assertNoSymlinkComponents(stagePath, plan.root);
    await writeFile(stagePath, operation.content, {
      encoding: typeof operation.content === "string" ? "utf8" : undefined,
      flag: "wx",
      mode: operation.mode,
    });
    artifacts.push(artifact);
    if (existing && operation.overwrite) {
      await chmod(stagePath, existing.mode & 0o7777);
    }
    stagedWrites.set(index, { artifact });
  }
  return stagedWrites;
}

async function applyMkdirOperation(
  operation: Extract<FileOperation, { kind: "mkdir" }>,
  root: string,
  createdDirectories: Set<string>,
  undoStack: UndoOperation[],
): Promise<void> {
  await assertOperationSafe(operation, root);
  const created = await ensureDirectory(operation.path, root, createdDirectories);
  undoStack.push(async () => {
    const errors = await cleanupCreatedDirectories(created, root);
    if (errors.length > 0) throw new Error(errors.map(errorMessage).join("; "));
  });
}

async function applyWriteOperation(
  operation: Extract<FileOperation, { kind: "write" }>,
  staged: StagedWrite | undefined,
  root: string,
  artifacts: TransactionArtifact[],
  createdDirectories: Set<string>,
  undoStack: UndoOperation[],
): Promise<void> {
  if (!staged) throw new Error(`missing staged write: ${operation.path}`);
  await assertOperationSafe(operation, root);
  const created = await ensureDirectory(dirname(operation.path), root, createdDirectories);
  const state: WriteUndoState = {
    targetInstalled: false,
    backup: undefined,
    backupMoved: false,
  };
  undoStack.push(async () => {
    const errors: Error[] = [];
    if (state.targetInstalled) {
      try {
        await assertNoSymlinkComponents(operation.path, root);
        await rm(operation.path, { recursive: false, force: false });
        state.targetInstalled = false;
      } catch (error) {
        errors.push(toError(error));
      }
    }
    if (state.backupMoved && state.backup) {
      try {
        await renameWithSafety(state.backup.path, operation.path, root);
        rewriteArtifacts(state.backup.path, operation.path, artifacts);
        state.backup.cleanupOnSuccess = false;
        state.backup.cleanupOnFailure = false;
        state.backupMoved = false;
      } catch (error) {
        errors.push(toError(error));
      }
    }
    errors.push(...await cleanupCreatedDirectories(created, root));
    if (errors.length > 0) throw new Error(errors.map(errorMessage).join("; "));
  });

  const existing = await lstatIfPresent(operation.path);
  if (existing?.isDirectory()) throw new Error(`planned file path is a directory: ${operation.path}`);
  if (existing && !operation.overwrite) {
    throw new Error(`planned file appeared before write: ${operation.path}`);
  }
  if (existing && operation.overwrite) {
    await access(operation.path, fsConstants.W_OK);
    await assertOperationSafe(operation, root);
    const backupPath = await uniqueSiblingPath(operation.path, "backup", root);
    await assertNoSymlinkComponents(backupPath, root);
    await rename(operation.path, backupPath);
    const backup: TransactionArtifact = {
      path: backupPath,
      kind: "backup",
      cleanupOnSuccess: true,
      cleanupOnFailure: true,
    };
    state.backup = backup;
    state.backupMoved = true;
    rewriteArtifacts(operation.path, backupPath, artifacts);
    artifacts.push(backup);
    await assertNoSymlinkComponents(staged.artifact.path, root);
    await chmod(staged.artifact.path, existing.mode & 0o7777);
  }

  await assertOperationSafe(operation, root);
  await assertNoSymlinkComponents(staged.artifact.path, root);
  if (existing && operation.overwrite) {
    await rename(staged.artifact.path, operation.path);
    staged.artifact.path = operation.path;
    staged.artifact.cleanupOnSuccess = false;
    state.targetInstalled = true;
    return;
  }

  await link(staged.artifact.path, operation.path);
  state.targetInstalled = true;
  await unlink(staged.artifact.path);
  staged.artifact.path = operation.path;
  staged.artifact.cleanupOnSuccess = false;
}

async function applyMoveOperation(
  operation: Extract<FileOperation, { kind: "move" }>,
  root: string,
  artifacts: TransactionArtifact[],
  createdDirectories: Set<string>,
  undoStack: UndoOperation[],
): Promise<void> {
  await assertOperationSafe(operation, root);
  const source = await lstatIfPresent(operation.from);
  if (!source) throw new Error(`move source does not exist: ${operation.from}`);
  const destination = await lstatIfPresent(operation.to);
  if (destination) throw new Error(`move destination already exists: ${operation.to}`);
  const created = await ensureDirectory(dirname(operation.to), root, createdDirectories);
  let moved = false;
  undoStack.push(async () => {
    const errors: Error[] = [];
    if (moved) {
      try {
        await renameWithSafety(operation.to, operation.from, root);
        rewriteArtifacts(operation.to, operation.from, artifacts);
        moved = false;
      } catch (error) {
        errors.push(toError(error));
      }
    }
    errors.push(...await cleanupCreatedDirectories(created, root));
    if (errors.length > 0) throw new Error(errors.map(errorMessage).join("; "));
  });
  await assertOperationSafe(operation, root);
  await rename(operation.from, operation.to);
  moved = true;
  rewriteArtifacts(operation.from, operation.to, artifacts);
}

async function applyRemoveOperation(
  operation: Extract<FileOperation, { kind: "remove" }>,
  root: string,
  artifacts: TransactionArtifact[],
  undoStack: UndoOperation[],
): Promise<void> {
  await assertOperationSafe(operation, root);
  const existing = await lstatIfPresent(operation.path);
  if (!existing) throw new Error(`remove path does not exist: ${operation.path}`);
  const backupPath = await uniqueSiblingPath(operation.path, "remove", root);
  await assertNoSymlinkComponents(backupPath, root);
  const backup: TransactionArtifact = {
    path: backupPath,
    kind: "backup",
    cleanupOnSuccess: true,
    cleanupOnFailure: true,
  };
  let moved = false;
  undoStack.push(async () => {
    if (!moved) return;
    await renameWithSafety(backup.path, operation.path, root);
    rewriteArtifacts(backup.path, operation.path, artifacts);
    backup.cleanupOnSuccess = false;
    backup.cleanupOnFailure = false;
    moved = false;
  });
  await assertOperationSafe(operation, root);
  await rename(operation.path, backupPath);
  moved = true;
  rewriteArtifacts(operation.path, backupPath, artifacts);
  artifacts.push(backup);
}

async function ensureDirectory(
  path: string,
  root: string,
  createdDirectories: Set<string>,
): Promise<readonly string[]> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assertInside(resolvedRoot, resolvedPath);
  await assertNoSymlinkComponents(resolvedPath, resolvedRoot);
  const missing: string[] = [];
  let current = resolvedPath;
  while (true) {
    const info = await lstatIfPresent(current);
    if (info) {
      if (!info.isDirectory()) throw new Error(`planned directory path is not a directory: ${current}`);
      break;
    }
    missing.push(current);
    if (current === resolvedRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of missing) createdDirectories.add(directory);
  await mkdir(resolvedPath, { recursive: true });
  await assertNoSymlinkComponents(resolvedPath, resolvedRoot);
  return missing;
}

async function uniqueSiblingPath(path: string, label: string, root: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(
      dirname(path),
      `${TRANSACTION_PREFIX}${label}-${randomUUID()}`,
    );
    await assertNoSymlinkComponents(candidate, root);
    if (!(await lstatIfPresent(candidate))) return candidate;
  }
  throw new Error(`could not allocate a unique transaction path beside ${path}`);
}

async function renameWithSafety(from: string, to: string, root: string): Promise<void> {
  await assertNoSymlinkComponents(from, root);
  await assertNoSymlinkComponents(to, root);
  await rename(from, to);
}

function rewriteArtifacts(
  from: string,
  to: string,
  artifacts: TransactionArtifact[],
): void {
  const prefix = `${from}${sep}`;
  for (const artifact of artifacts) {
    if (artifact.path === from) {
      artifact.path = to;
    } else if (artifact.path.startsWith(prefix)) {
      artifact.path = join(to, relative(from, artifact.path));
    }
  }
}

async function rollback(undoStack: UndoOperation[]): Promise<Error[]> {
  const errors: Error[] = [];
  for (let index = undoStack.length - 1; index >= 0; index -= 1) {
    try {
      await undoStack[index]();
    } catch (error) {
      errors.push(toError(error));
    }
  }
  return errors;
}

async function cleanupArtifacts(
  artifacts: TransactionArtifact[],
  root: string,
  success: boolean,
): Promise<Error[]> {
  const selected = artifacts
    .filter((artifact) => success ? artifact.cleanupOnSuccess : artifact.cleanupOnFailure)
    .sort((left, right) => right.path.length - left.path.length);
  const seen = new Set<string>();
  const errors: Error[] = [];
  for (const artifact of selected) {
    if (seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    try {
      await assertNoSymlinkComponents(artifact.path, root);
      await rm(artifact.path, {
        recursive: success && artifact.kind === "backup",
        force: false,
      });
    } catch (error) {
      if (!isMissing(error)) errors.push(toError(error));
    }
  }
  return errors;
}

async function cleanupCreatedDirectories(
  directories: Iterable<string>,
  root: string,
): Promise<Error[]> {
  const errors: Error[] = [];
  const paths = [...directories].sort((left, right) => right.length - left.length);
  for (const path of paths) {
    try {
      await assertNoSymlinkComponents(path, root);
      await rm(path, { recursive: false, force: false });
    } catch (error) {
      if (!isMissing(error)) errors.push(toError(error));
    }
  }
  return errors;
}


function withRollbackContext(error: unknown, rollbackErrors: Error[]): Error {
  const context = rollbackErrors.map(errorMessage).join("; ");
  if (error instanceof Error) {
    error.message = `${error.message}; rollback failed: ${context}`;
    return error;
  }
  return new Error(`${errorMessage(error)}; rollback failed: ${context}`, { cause: error });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
