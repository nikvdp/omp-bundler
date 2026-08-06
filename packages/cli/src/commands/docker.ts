import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolvePackagedAsset } from "../assets.ts";
import {
  CANONICAL_ASSET_PATHS,
  isExcludedAssetName,
} from "../package-assets.ts";
export { CANONICAL_ASSET_PATHS } from "../package-assets.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import type { LoadedModelBundle } from "../model-config.ts";
import type { AgentDirectory, ProjectConfig } from "../types.ts";


export const BUNDLE_ROOT_LABEL = "io.omp-bundler.bundle-root";

export interface RunDockerArguments {
  readonly image: string;
  readonly corePort: number;
  readonly adapterPort: number;
  readonly dataVolume: string;
  readonly envFile: string;
  readonly bundleRoot: string;
  readonly containerName?: string;
  readonly detached?: boolean;
}

/** Resolve the package asset directory without depending on process.cwd(). */
export async function packagedAssetsRoot(): Promise<string> {
  return dirname(await resolvePackagedAsset("Dockerfile"));
}

export function buildDockerArgs(
  tag: string,
  contextPath: string,
): readonly string[] {
  return ["build", "-t", tag, contextPath];
}

export function runDockerArgs(
  options: RunDockerArguments,
): readonly string[] {
  return [
    "run",
    "--rm",
    ...(options.detached ? ["-d"] : []),
    ...(options.containerName === undefined ? [] : ["--name", options.containerName]),
    "--label",
    `${BUNDLE_ROOT_LABEL}=${options.bundleRoot}`,
    "-p",
    `${options.corePort}:8787`,
    "-p",
    `${options.adapterPort}:8765`,
    "-v",
    `${options.dataVolume}:/data`,
    "--env-file",
    options.envFile,
    options.image,
  ];
}

/** Quote one argument for a POSIX shell command preview. */
export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatDockerCommand(
  executable: string,
  args: readonly string[],
): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

/**
 * Stage a fresh context from packaged assets and the single root agent.
 * Runtime consumes agent/id and agent/.omp; source subagents are translated
 * to the OMP-native agents directory inside .omp.
 */
export async function stageDockerContext(
  agents: readonly AgentDirectory[],
  modelsOrAssetsRoot?: LoadedModelBundle | string,
  assetsRoot?: string,
  filesConfig?: ProjectConfig["files"],
): Promise<string> {
  const models = typeof modelsOrAssetsRoot === "object" ? modelsOrAssetsRoot : undefined;
  const sourceAssetsRoot = typeof modelsOrAssetsRoot === "string" ? modelsOrAssetsRoot : assetsRoot;
  const contextPath = await mkdtemp(join(tmpdir(), "omp-bundler-build-"));
  try {
    const sourceRoot = resolve(sourceAssetsRoot ?? await packagedAssetsRoot());
    for (const assetPath of CANONICAL_ASSET_PATHS) {
      await copyTreeNoSymlinks(join(sourceRoot, assetPath), join(contextPath, assetPath), true);
    }
    if (agents.length !== 1) throw new Error("exactly one root agent is required");
    const agent = agents[0];
    assertSafeIdentifier(agent.id, "agent id");
    const stagedAgent = join(contextPath, "agent");
    const stagedOmp = join(stagedAgent, ".omp");
    const bundleDockerfile = join(agent.path, "Dockerfile");
    await copyTreeNoSymlinks(bundleDockerfile, join(contextPath, "Dockerfile"), false);
    await mkdir(stagedAgent, { recursive: true });
    await writeFile(join(stagedAgent, "id"), `${agent.id}\n`, "utf8");
    await copyAgentSourceNoSymlinks(agent.path, stagedOmp);
    // Stage the bundle-root schedules/ directory (cron source) when present so
    // the Dockerfile's `COPY schedules/ /schedules/` resolves. Optional: a
    // bundle without schedules simply stages nothing and runs core + adapter.
    const schedulesSource = join(agent.path, "schedules");
    if (await lstat(schedulesSource).catch(() => null)) {
      await copyTreeNoSymlinks(schedulesSource, join(contextPath, "schedules"), true);
    }
    await writeFile(join(stagedAgent, "files.json"), JSON.stringify(filesConfig ?? [], null, 2), "utf8");

    if (models !== undefined) {
      await writeFile(join(contextPath, "template", "models.yml.tmpl"), models.source, "utf8");
    }
    return contextPath;
  } catch (error) {
    await removeDockerContext(contextPath);
    throw error;
  }
}

async function copyAgentSourceNoSymlinks(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isDirectory()) throw new Error(`agent source must be a directory: ${sourcePath}`);
  await mkdir(destinationPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries.sort((left: { readonly name: string }, right: { readonly name: string }) => left.name.localeCompare(right.name))) {
    const sourceEntry = join(sourcePath, entry.name);
    const entryInfo = await lstat(sourceEntry);
    if (entryInfo.isSymbolicLink()) throw new Error(`refusing to stage symlink: ${sourceEntry}`);
    if (entry.name === ".git" || entry.name === ".omp" || entry.name === "models.yml" || entry.name === "runtime.env") continue;
    const destinationName = entry.name === "subagents" ? "agents" : entry.name;
    await copyTreeNoSymlinks(sourceEntry, join(destinationPath, destinationName), false);
  }
}


export async function removeDockerContext(contextPath: string): Promise<void> {
  await rm(contextPath, { recursive: true, force: true });
}

async function copyTreeNoSymlinks(
  sourcePath: string,
  destinationPath: string,
  skipPackagedState: boolean,
): Promise<void> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to stage symlink: ${sourcePath}`);
  }
  if (info.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries.sort((left: { readonly name: string }, right: { readonly name: string }) => left.name.localeCompare(right.name))) {
      if (skipPackagedState && isExcludedAssetName(entry.name)) continue;
      await copyTreeNoSymlinks(join(sourcePath, entry.name), join(destinationPath, entry.name), skipPackagedState);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`cannot stage non-regular file: ${sourcePath}`);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}
