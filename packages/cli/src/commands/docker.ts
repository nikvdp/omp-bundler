import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolvePackagedAsset } from "../assets.ts";
import {
  CANONICAL_ASSET_PATHS,
  isExcludedAssetName,
} from "../package-assets.ts";
export { CANONICAL_ASSET_PATHS } from "../package-assets.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import {
  renderModelCatalog,
  stageAgentModelBinding,
  type LoadedModelBundle,
} from "../model-config.ts";
import type { AgentDirectory } from "../types.ts";


export interface RunDockerArguments {
  readonly image: string;
  readonly corePort: number;
  readonly adapterPort: number;
  readonly dataVolume: string;
  readonly envFile: string;
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
 * Stage a fresh context from packaged assets and validated agent source
 * trees. Each agent's visible root is wrapped under agents/<id>/.omp in the
 * context; the root template catalog and staged agent configs bind models.
 * Every source entry is lstat-checked, so no symlink is ever copied.
 */
export async function stageDockerContext(
  agents: readonly AgentDirectory[],
  modelsOrAssetsRoot?: LoadedModelBundle | string,
  assetsRoot?: string,
): Promise<string> {
  const models = typeof modelsOrAssetsRoot === "object" ? modelsOrAssetsRoot : undefined;
  const sourceAssetsRoot = typeof modelsOrAssetsRoot === "string" ? modelsOrAssetsRoot : assetsRoot;
  const contextPath = await mkdtemp(join(tmpdir(), "omp-bundler-build-"));
  try {
    const sourceRoot = resolve(sourceAssetsRoot ?? await packagedAssetsRoot());
    for (const assetPath of CANONICAL_ASSET_PATHS) {
      await copyTreeNoSymlinks(
        join(sourceRoot, assetPath),
        join(contextPath, assetPath),
        true,
      );
    }
    if (models !== undefined) {
      await writeFile(join(contextPath, "template", "models.yml.tmpl"), renderModelCatalog(models.connections), "utf8");
    }

    const stagedAgents = join(contextPath, "agents");
    await mkdir(stagedAgents, { recursive: true });
    const ids = new Set<string>();
    for (const agent of [...agents].sort((left, right) => left.id.localeCompare(right.id))) {
      assertSafeIdentifier(agent.id, "agent id");
      if (ids.has(agent.id)) throw new Error(`duplicate agent id: ${agent.id}`);
      ids.add(agent.id);
      await copyTreeNoSymlinks(
        agent.path,
        join(stagedAgents, agent.id, ".omp"),
        false,
      );
      if (models === undefined) continue;
      const connection = models.connections.find((entry) => entry.agentId === agent.id);
      if (!connection) throw new Error(`missing validated model connection for agent '${agent.id}'`);
      const configPath = join(agent.path, "config.yml");
      const source = await readFile(configPath, "utf8");
      const stagedConfig = stageAgentModelBinding(
        source,
        connection.providerId,
        connection.config.model,
        configPath,
      );
      await writeFile(join(stagedAgents, agent.id, ".omp", "config.yml"), stagedConfig, "utf8");
    }
    return contextPath;
  } catch (error) {
    await removeDockerContext(contextPath);
    throw error;
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
