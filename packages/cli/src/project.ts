import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readYamlFile } from "./config.ts";
import { assertSafeIdentifier, resolveInside } from "./identifiers.ts";
import type {
  AgentDirectory,
  ProjectConfig,
  ProjectContext,
  YamlValue,
} from "./types.ts";

export const PROJECT_CONFIG_FILE = "omp-bundler.yml";

export async function resolveBundleRoot(
  bundlePath?: string,
  cwd = process.cwd(),
): Promise<string> {
  if (bundlePath !== undefined) {
    const candidate = resolve(cwd, bundlePath);
    const info = await lstat(candidate).catch((error: unknown) => {
      throw new Error(`bundle path '${bundlePath}' is not accessible: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!info.isDirectory()) throw new Error(`bundle path is not a directory: ${candidate}`);
    return candidate;
  }

  let current = resolve(cwd);
  while (true) {
    const configPath = join(current, PROJECT_CONFIG_FILE);
    const config = await lstat(configPath).catch(() => null);
    if (config?.isFile()) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not find ${PROJECT_CONFIG_FILE} from ${cwd}`);
}

export async function loadProject(
  bundlePath?: string,
  cwd = process.cwd(),
): Promise<ProjectContext> {
  const rootDir = await resolveBundleRoot(bundlePath, cwd);
  const configPath = join(rootDir, PROJECT_CONFIG_FILE);
  const parsed = await readYamlFile(configPath);
  if (!isRecord(parsed)) throw new Error(`${configPath}: expected a mapping`);
  if (parsed.version !== 1) throw new Error(`${configPath}: version must be 1`);
  if (typeof parsed.agentsDir !== "string" || !parsed.agentsDir.trim()) {
    throw new Error(`${configPath}: agentsDir must be a non-empty path`);
  }
  if (isAbsolute(parsed.agentsDir)) {
    throw new Error(`${configPath}: agentsDir must be relative to the bundle`);
  }
  const agentsDir = resolveInside(rootDir, parsed.agentsDir);
  return {
    rootDir,
    configPath,
    config: parsed as ProjectConfig,
    agentsDir,
  };
}

export async function discoverAgents(
  agentsDir: string,
): Promise<AgentDirectory[]> {
  const info = await lstat(agentsDir).catch((error: unknown) => {
    throw new Error(`agents directory '${agentsDir}' is not accessible: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!info.isDirectory()) throw new Error(`agents path is not a directory: ${agentsDir}`);
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const agents: AgentDirectory[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".gitkeep") continue;
    const agentPath = join(agentsDir, entry.name);
    const entryInfo = await lstat(agentPath);
    if (entryInfo.isSymbolicLink()) throw new Error(`agent path must not be a symlink: ${agentPath}`);
    if (!entryInfo.isDirectory()) throw new Error(`agent collection entry is not a directory: ${agentPath}`);
    assertSafeIdentifier(entry.name, "agent id");
    const legacyOmpPath = join(agentPath, ".omp");
    const legacyOmpInfo = await lstat(legacyOmpPath).catch(() => null);
    if (legacyOmpInfo) {
      throw new Error(`agent '${entry.name}' has a nested .omp directory; agent source must live at the agent root: ${agentPath}`);
    }
    agents.push({ id: entry.name, path: agentPath });
  }
  return agents;
}

export function resolveAgentPath(
  project: ProjectContext,
  agentId: string,
): string {
  assertSafeIdentifier(agentId, "agent id");
  return resolveInside(project.agentsDir, agentId);
}

export function resolveCommandPath(path: string, cwd: string): string {
  if (isAbsolute(path)) return resolve(path);
  return resolve(cwd, path);
}

/**
 * Resolve the bundle's default runtime.env path. Returns the path if a
 * `runtime.env` entry exists at the bundle root (any type — symlink or
 * otherwise), or `undefined` when absent. {@link validateBundle} remains
 * the authority that rejects symlinks and non-file entries.
 */
export async function resolveDefaultEnvFile(bundleRoot: string): Promise<string | undefined> {
  const path = join(bundleRoot, "runtime.env");
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: YamlValue): value is { [key: string]: YamlValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
