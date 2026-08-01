import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { optionString } from "../args.ts";
import { parseYaml } from "../config.ts";
import {
  assertSafeRelativePath,
  isSafeIdentifier,
  resolveInside,
} from "../identifiers.ts";
import {
  PROJECT_CONFIG_FILE,
  resolveBundleRoot,
  resolveCommandPath,
} from "../project.ts";
import type {
  AgentDirectory,
  CommandContext,
  CommandHandler,
  ParsedArguments,
  ProjectConfig,
  ProjectContext,
  YamlValue,
} from "../types.ts";

export interface ValidationIssue {
  readonly path: string;
  readonly field?: string;
  readonly message: string;
}

export interface CheckOptions {
  readonly cwd: string;
  readonly bundlePath?: string;
  readonly agentsDirOverride?: string;
  readonly envFile?: string;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly project: ProjectContext;
  readonly agentsDir: string;
  readonly agents: readonly AgentDirectory[];
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly credentialNames: readonly string[];
  readonly envFile?: string;
}

const PROJECT_KEYS: Record<string, true> = { version: true, agentsDir: true, image: true, run: true };
const IMAGE_KEYS: Record<string, true> = { tag: true };
const RUN_KEYS: Record<string, true> = { dataVolume: true, corePort: true, adapterPort: true };
const OMP_ALLOWED: Record<string, true> = {
  "AGENTS.md": true,
  "config.yml": true,
  "settings.json": true,
  agents: true,
  commands: true,
  extensions: true,
  skills: true,
  tools: true,
};
const OMP_REQUIRED_FILES = ["AGENTS.md", "config.yml"] as const;
const OMP_REQUIRED_DIRS = ["agents", "commands", "extensions", "skills", "tools"] as const;
const GLOBAL_STATE_NAMES = /^(?:models\.ya?ml(?:\.tmpl)?|sessions?|(?:\.?cache|caches?)(?:[.-].*)?|agent\.db(?:[.-].*)?|runtime(?:[._-].*)?|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?)$/i;
const SECRET_ENV_NAME = /(?:API_KEY|APP_KEY|CLIENT_SECRET|SIGNING_SECRET|SHARED_SECRET|AUTH_BROKER_TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|TOKEN)$/i;
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/;
const SECRET_ASSIGNMENT = /(?:\b(?:const|let|var)\s+|(?:^|[,{.;(])\s*|\.)(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$-]*))\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|(\$\{[^}]*\}|[^\s,;}]+))/gm;
const ENV_REFERENCE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-+?][^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|(?:process\.env|env)\.[A-Za-z_][A-Za-z0-9_]*)$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPONENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const URL_ENV_NAMES: Record<string, true> = {
  OMP_AUTH_BROKER_URL: true,
  PUMBLE_PUBLIC_BASE_URL: true,
  PUMBLE_CORE_URL: true,
  PUMBLE_CORE_CALLBACK_URL: true,
  PUMBLE_API_BASE_URL: true,
  PUMBLE_FILE_HOST_BASE_URL: true,
  CLIPROXY_BASE_URL: true,
  custom-provider_BASE_URL: true,
};
const CREDENTIAL_ENV_NAMES: Record<string, true> = {
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_ADAPTERS: true,
  CLIPROXY_API_KEY: true,
  custom-provider_API_KEY: true,
  OLLAMA_CLOUD_API_KEY: true,
  OPENCODE_GO_API_KEY: true,
  PUMBLE_APP_CLIENT_SECRET: true,
  PUMBLE_APP_KEY: true,
  PUMBLE_APP_SIGNING_SECRET: true,
  PUMBLE_CORE_SHARED_SECRET: true,
};
const PUMBLE_REQUIRED = [
  "PUMBLE_APP_ID",
  "PUMBLE_APP_CLIENT_SECRET",
  "PUMBLE_APP_KEY",
  "PUMBLE_APP_SIGNING_SECRET",
  "PUMBLE_PUBLIC_BASE_URL",
  "PUMBLE_CORE_SHARED_SECRET",
] as const;

interface EnvValue {
  readonly value: string;
  readonly line: number;
  readonly quoted: boolean;
}

type EnvMap = Map<string, EnvValue>;
type RecordValue = { [key: string]: YamlValue };

/**
 * Validate a bundle without writing files, contacting providers, or reading
 * process.env. The returned report is deliberately safe to pass to build/run.
 */
export async function validateBundle(options: CheckOptions): Promise<CheckResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const credentialNames = new Set<string>();
  const rootDir = await resolveBundleRoot(options.bundlePath, options.cwd);
  const configPath = join(rootDir, PROJECT_CONFIG_FILE);
  let parsedConfig: YamlValue | undefined;

  const configStat = await lstat(configPath).catch(() => null);
  if (configStat?.isSymbolicLink()) {
    errors.push(issue(configPath, undefined, "must not be a symlink; keep project configuration in the bundle"));
  } else if (!configStat) {
    errors.push(issue(configPath, undefined, "is missing; create omp-bundler.yml with version: 1 and agentsDir"));
  } else if (!configStat.isFile()) {
    errors.push(issue(configPath, undefined, "must be a regular file"));
  } else {
    try {
      parsedConfig = parseYaml(await readFile(configPath, "utf8"));
    } catch {
      errors.push(issue(configPath, undefined, "is not valid YAML; fix its syntax without committing credentials"));
    }
  }

  const projectInfo = buildProjectContext(rootDir, configPath, parsedConfig, errors);
  const effectiveAgentsDir = resolveEffectiveAgentsDir(options, projectInfo.project, rootDir, errors);
  const agents = await validateAgentCollection(effectiveAgentsDir, errors, warnings);
  for (const agent of agents) {
    await validateAgent(agent, errors, warnings);
  }

  let resolvedEnvFile: string | undefined;
  if (options.envFile !== undefined) {
    resolvedEnvFile = resolveCommandPath(options.envFile, options.cwd);
    const envStat = await lstat(resolvedEnvFile).catch(() => null);
    if (!envStat) {
      errors.push(issue(resolvedEnvFile, undefined, "is missing; provide a Docker env-file with runtime values"));
    } else if (envStat.isSymbolicLink()) {
      errors.push(issue(resolvedEnvFile, undefined, "must not be a symlink"));
    } else if (!envStat.isFile()) {
      errors.push(issue(resolvedEnvFile, undefined, "must be a regular Docker env-file"));
    } else {
      let envSource = "";
      try {
        envSource = await readFile(resolvedEnvFile, "utf8");
      } catch {
        errors.push(issue(resolvedEnvFile, undefined, "cannot be read; check file permissions"));
      }
      if (envSource.length > 0 || errors.every((entry) => entry.path !== resolvedEnvFile)) {
        const parsedEnv = parseDockerEnv(envSource, resolvedEnvFile, errors);
        for (const [name, value] of parsedEnv.entries()) {
          if (isCredentialName(name) && value.value.trim()) credentialNames.add(name);
        }
        validateRuntimeEnv(parsedEnv, envSource, resolvedEnvFile, agents, errors);
      }
      }
    }

  return {
    ok: errors.length === 0,
    project: projectInfo.project,
    agentsDir: effectiveAgentsDir,
    agents,
    errors,
    warnings,
    credentialNames: [...credentialNames].sort(),
    ...(resolvedEnvFile === undefined ? {} : { envFile: resolvedEnvFile }),
  };
}

/** Format an issue without exposing source or environment values. */
export function formatIssue(entry: ValidationIssue): string {
  return `${entry.path}${entry.field ? ` [${entry.field}]` : ""}: ${entry.message}`;
}

export const checkCommand: CommandHandler = async (
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> => {
  if (args.positionals.length > 1) {
    context.io.stderr.write("omp-bundler check accepts at most one bundle path\n");
    return 1;
  }
  const unknownOptions = Object.keys(args.options).filter((name) => name !== "env-file");
  if (unknownOptions.length > 0) {
    context.io.stderr.write(`omp-bundler check: unknown option --${unknownOptions[0]}\n`);
    return 1;
  }
  const envFile = optionString(args, "env-file");
  if (args.options["env-file"] !== undefined && envFile === undefined) {
    context.io.stderr.write("omp-bundler check: --env-file requires a path\n");
    return 1;
  }

  const result = await validateBundle({
    cwd: context.cwd,
    ...(args.positionals[0] === undefined ? {} : { bundlePath: args.positionals[0] }),
    ...(envFile === undefined ? {} : { envFile }),
  });
  const output = context.io.stdout;
  output.write(`Bundle: ${result.project.rootDir}\n`);
  output.write(`Agent collection: ${result.agentsDir}\n`);
  output.write(`Agents: ${result.agents.length > 0 ? result.agents.map((agent) => agent.id).join(", ") : "(none)"}\n`);
  output.write(`Credential names present: ${result.credentialNames.length > 0 ? result.credentialNames.join(", ") : "(none)"}\n`);
  for (const warning of result.warnings) output.write(`Warning: ${formatIssue(warning)}\n`);
  if (result.errors.length > 0) {
    context.io.stderr.write(`omp-bundler check found ${result.errors.length} error(s):\n`);
    for (const error of result.errors) context.io.stderr.write(`Error: ${formatIssue(error)}\n`);
    return 1;
  }
  output.write("Check passed.\n");
  return 0;
};

function buildProjectContext(
  rootDir: string,
  configPath: string,
  parsed: YamlValue | undefined,
  errors: ValidationIssue[],
): { project: ProjectContext; config: RecordValue | undefined } {
  const fallbackConfig: ProjectConfig = { version: 1, agentsDir: "agents" };
  if (!isRecord(parsed)) {
    if (parsed !== undefined) errors.push(issue(configPath, undefined, "must contain a YAML mapping"));
    return {
      project: {
        rootDir,
        configPath,
        config: fallbackConfig,
        agentsDir: join(rootDir, "agents"),
      },
      config: undefined,
    };
  }
  validateProjectConfig(parsed, configPath, rootDir, errors);
  const agentsRel = typeof parsed.agentsDir === "string" && parsed.agentsDir.trim()
    ? parsed.agentsDir
    : "agents";
  let agentsDir: string;
  try {
    agentsDir = resolveInside(rootDir, agentsRel);
  } catch {
    agentsDir = join(rootDir, "agents");
  }
  return {
    project: { rootDir, configPath, config: parsed as ProjectConfig, agentsDir },
    config: parsed,
  };
}

function validateProjectConfig(
  value: RecordValue,
  path: string,
  rootDir: string,
  errors: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!(key in PROJECT_KEYS)) errors.push(issue(path, key, "is not a supported bundle configuration field"));
  }
  if (value.version !== 1) {
    errors.push(issue(path, "version", "must be the number 1"));
  }
  if (typeof value.agentsDir !== "string" || !value.agentsDir.trim()) {
    errors.push(issue(path, "agentsDir", "must be a non-empty relative path"));
  } else {
    try {
      assertSafeRelativePath(value.agentsDir, "agentsDir");
      resolveInside(rootDir, value.agentsDir);
    } catch {
      errors.push(issue(path, "agentsDir", "must be a safe relative path inside the bundle"));
    }
  }
  if (value.image !== undefined) validateMapping(value.image, path, "image", IMAGE_KEYS, errors);
  if (value.run !== undefined) {
    validateMapping(value.run, path, "run", RUN_KEYS, errors);
    if (isRecord(value.run)) {
      if (value.run.dataVolume !== undefined && (
        typeof value.run.dataVolume !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.run.dataVolume)
      )) {
        errors.push(issue(path, "run.dataVolume", "must be a safe Docker named-volume name"));
      }
      for (const field of ["corePort", "adapterPort"] as const) {
        if (value.run[field] !== undefined && !validPort(value.run[field])) {
          errors.push(issue(path, `run.${field}`, "must be an integer from 1 through 65535"));
        }
      }
    }
  }
  if (isRecord(value.image) && value.image.tag !== undefined && (
    typeof value.image.tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.image.tag) || value.image.tag.includes("..")
  )) {
    errors.push(issue(path, "image.tag", "must be a safe Docker image tag without traversal, whitespace, or shell expansion"));
  }
}

function validateMapping(
  value: YamlValue,
  path: string,
  field: string,
  allowed: Readonly<Record<string, true>>,
  errors: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    errors.push(issue(path, field, "must be a mapping"));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in allowed)) errors.push(issue(path, `${field}.${key}`, "is not a supported field"));
  }
}

function resolveEffectiveAgentsDir(
  options: CheckOptions,
  project: ProjectContext,
  rootDir: string,
  errors: ValidationIssue[],
): string {
  if (options.agentsDirOverride === undefined) return project.agentsDir;
  if (!options.agentsDirOverride.trim()) {
    errors.push(issue("--agents", undefined, "must be a non-empty agent collection path"));
    return project.agentsDir;
  }
  const resolved = resolveCommandPath(options.agentsDirOverride, options.cwd);
  if (isAbsolute(options.agentsDirOverride)) return resolved;
  // Command-line paths intentionally resolve from the shell cwd. They may
  // point outside the bundle, but lexical traversal in a project config may not.
  if (resolved === rootDir) {
    errors.push(issue(options.agentsDirOverride, undefined, "must point to an agent collection, not the bundle root"));
  }
  return resolved;
}

async function validateAgentCollection(
  agentsDir: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): Promise<AgentDirectory[]> {
  const collectionInfo = await lstat(agentsDir).catch(() => null);
  if (!collectionInfo) {
    errors.push(issue(agentsDir, undefined, "agent collection is missing; create the directory or fix agentsDir"));
    return [];
  }
  if (collectionInfo.isSymbolicLink()) {
    errors.push(issue(agentsDir, undefined, "agent collection must not be a symlink"));
    return [];
  }
  if (!collectionInfo.isDirectory()) {
    errors.push(issue(agentsDir, undefined, "agent collection must be a directory"));
    return [];
  }

  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    errors.push(issue(agentsDir, undefined, "agent collection cannot be read; check permissions"));
    return [];
  }
  const agents: AgentDirectory[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const entryPath = join(agentsDir, name);
    if (name === ".gitkeep") {
      const placeholder = await lstat(entryPath).catch(() => null);
      if (placeholder?.isSymbolicLink()) errors.push(issue(entryPath, undefined, "placeholder must not be a symlink"));
      else if (placeholder && !placeholder.isFile()) errors.push(issue(entryPath, undefined, "placeholder must be a regular file"));
      continue;
    }
    const info = await lstat(entryPath).catch(() => null);
    if (!info) {
      errors.push(issue(entryPath, undefined, "agent entry disappeared while checking; retry the command"));
      continue;
    }
    if (info.isSymbolicLink()) {
      errors.push(issue(entryPath, undefined, "agent directory must not be a symlink"));
      continue;
    }
    if (!info.isDirectory()) {
      errors.push(issue(entryPath, undefined, "every direct child of agentsDir must be an agent directory; only .gitkeep may be a file"));
      continue;
    }
    if (!COMPONENT_ID.test(name)) {
      errors.push(issue(entryPath, "agent id", "must use 1-64 lowercase letters, numbers, '-' or '_' and start with a letter or number"));
      continue;
    }
    const ompPath = join(entryPath, ".omp");
    const ompInfo = await lstat(ompPath).catch(() => null);
    if (!ompInfo) {
      errors.push(issue(ompPath, undefined, "is required for every agent"));
      continue;
    }
    if (ompInfo.isSymbolicLink()) {
      errors.push(issue(ompPath, undefined, "must not be a symlink"));
      continue;
    }
    if (!ompInfo.isDirectory()) {
      errors.push(issue(ompPath, undefined, "must be a directory"));
      continue;
    }
    agents.push({ id: name, path: entryPath, ompPath });
  }
  return agents;
}

async function validateAgent(
  agent: AgentDirectory,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): Promise<void> {
  await scanTree(agent.path, agent.path, errors, warnings, true);
  const entries = await readdir(agent.ompPath).catch(() => [] as string[]);
  for (const required of OMP_REQUIRED_FILES) {
    const path = join(agent.ompPath, required);
    const info = await lstat(path).catch(() => null);
    if (!info) {
      errors.push(issue(path, undefined, "is required in every agent .omp scaffold"));
    } else if (info.isSymbolicLink()) {
      errors.push(issue(path, undefined, "must not be a symlink"));
    } else if (!info.isFile()) {
      errors.push(issue(path, undefined, "must be a regular file"));
    }
  }
  for (const required of OMP_REQUIRED_DIRS) {
    const path = join(agent.ompPath, required);
    const info = await lstat(path).catch(() => null);
    if (!info) {
      errors.push(issue(path, undefined, "is required in every agent .omp scaffold"));
    } else if (info.isSymbolicLink()) {
      errors.push(issue(path, undefined, "must not be a symlink"));
    } else if (!info.isDirectory()) {
      errors.push(issue(path, undefined, "must be a directory"));
    }
  }
  for (const entry of entries) {
    const path = join(agent.ompPath, entry);
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (GLOBAL_STATE_NAMES.test(entry) || /^agent\.db/i.test(entry)) continue;
    if (!(entry in OMP_ALLOWED)) {
      errors.push(issue(path, undefined, "is not an allowed .omp surface; use AGENTS.md, config.yml, settings.json, agents, commands, extensions, skills, or tools"));
      continue;
    }
    const expectsDirectory = (OMP_REQUIRED_DIRS as readonly string[]).includes(entry);
    if (expectsDirectory && !info.isDirectory()) errors.push(issue(path, undefined, "must be a directory"));
    if (!expectsDirectory && !info.isFile()) errors.push(issue(path, undefined, "must be a regular file"));
  }

  await validateTextFile(join(agent.ompPath, "AGENTS.md"), "instructions", errors, (source, path) => {
    if (!source.trim()) errors.push(issue(path, undefined, "must not be empty"));
  });
  await validateYamlFile(join(agent.ompPath, "config.yml"), "agent config", errors, validateAgentConfig);
  const settingsPath = join(agent.ompPath, "settings.json");
  const settings = await lstat(settingsPath).catch(() => null);
  if (settings?.isFile()) await validateJsonFile(settingsPath, errors);
  await validateComponents(agent, errors);
}

async function scanTree(
  root: string,
  current: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  includeSiblings: boolean,
): Promise<void> {
  const entries = await readdir(current).catch(() => [] as string[]);
  for (const name of entries) {
    const path = join(current, name);
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      errors.push(issue(path, undefined, "symlinks are not allowed in agent source"));
      continue;
    }
    if (GLOBAL_STATE_NAMES.test(name) || /^agent\.db/i.test(name)) {
      errors.push(issue(path, undefined, "runtime state, cache, model catalog, or credential material must not be committed in agent source"));
    }
    if (info.isDirectory()) {
      await scanTree(root, path, errors, warnings, includeSiblings);
      continue;
    }
    if (!info.isFile()) {
      errors.push(issue(path, undefined, "must be a regular file"));
      continue;
    }
    if (includeSiblings && !path.startsWith(`${join(root, ".omp")}${"/"}`) && !path.endsWith(`${join(root, ".omp")}`)) {
      warnings.push(issue(path, undefined, "sibling files are not baked into the image; keep deployable OMP content under .omp"));
    }
    if (isTextPath(path)) {
      const source = await readFile(path, "utf8").catch(() => "");
      scanCredentialAssignments(source, path, errors);
    }
  }
}

async function validateComponents(agent: AgentDirectory, errors: ValidationIssue[]): Promise<void> {
  await validateMarkdownDirectory(join(agent.ompPath, "agents"), "agents", errors);
  await validateMarkdownDirectory(join(agent.ompPath, "commands"), "commands", errors);
  await validateTypeScriptDirectory(join(agent.ompPath, "extensions"), "extension", errors);
  await validateTypeScriptDirectory(join(agent.ompPath, "tools"), "tool", errors);
  await validateSkillsDirectory(join(agent.ompPath, "skills"), errors);
}

async function validateMarkdownDirectory(
  directory: string,
  kind: "agents" | "commands",
  errors: ValidationIssue[],
): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return;
  const names = await readdir(directory).catch(() => [] as string[]);
  const seen = new Set<string>();
  for (const name of names.sort()) {
    const path = join(directory, name);
    if (name === ".gitkeep") continue;
    const entry = await lstat(path).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      errors.push(issue(path, undefined, "component files must not be symlinks"));
      continue;
    }
    if (!entry.isFile()) {
      errors.push(issue(path, undefined, `${kind} entries must be Markdown files`));
      continue;
    }
    const parsed = componentFileName(name, ".md");
    if (!parsed) {
      errors.push(issue(path, undefined, `must be named <component-name>.md or <component-name>.md.example`));
      continue;
    }
    if (!parsed.example && seen.has(parsed.id)) errors.push(issue(path, "component name", `duplicates active ${kind} component '${parsed.id}'`));
    if (!parsed.example) seen.add(parsed.id);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) {
      errors.push(issue(path, undefined, "cannot be read; check permissions"));
      continue;
    }
    validateFrontmatter(path, source, kind === "agents" ? "subagent" : "command", parsed.id, errors);
    scanCredentialAssignments(source, path, errors);
  }
}

async function validateTypeScriptDirectory(
  directory: string,
  kind: "extension" | "tool",
  errors: ValidationIssue[],
): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return;
  const names = await readdir(directory).catch(() => [] as string[]);
  const seen = new Set<string>();
  for (const name of names.sort()) {
    const path = join(directory, name);
    if (name === ".gitkeep") continue;
    const entry = await lstat(path).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      errors.push(issue(path, undefined, "component files must not be symlinks"));
      continue;
    }
    if (!entry.isFile()) {
      errors.push(issue(path, undefined, `${kind} entries must be TypeScript files`));
      continue;
    }
    const parsed = componentFileName(name, ".ts");
    if (!parsed) {
      errors.push(issue(path, undefined, `must be named <component-name>.ts or <component-name>.ts.example`));
      continue;
    }
    if (!parsed.example && seen.has(parsed.id)) errors.push(issue(path, "component name", `duplicates active ${kind} component '${parsed.id}'`));
    if (!parsed.example) seen.add(parsed.id);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) {
      errors.push(issue(path, undefined, "cannot be read; check permissions"));
      continue;
    }
    validateTypeScript(path, source, kind, errors);
    scanCredentialAssignments(source, path, errors);
  }
}

async function validateSkillsDirectory(directory: string, errors: ValidationIssue[]): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return;
  const names = await readdir(directory).catch(() => [] as string[]);
  const seen = new Set<string>();
  for (const name of names.sort()) {
    const path = join(directory, name);
    if (name === ".gitkeep") continue;
    const entry = await lstat(path).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      errors.push(issue(path, undefined, "skill directories must not be symlinks"));
      continue;
    }
    if (!entry.isDirectory() || !isSafeIdentifier(name)) {
      errors.push(issue(path, "skill name", "must be a directory with a safe component name"));
      continue;
    }
    if (seen.has(name)) errors.push(issue(path, "skill name", `duplicates active skill '${name}'`));
    seen.add(name);
    const skillNames = await readdir(path).catch(() => [] as string[]);
    for (const fileName of skillNames) {
      const filePath = join(path, fileName);
      const fileInfo = await lstat(filePath).catch(() => null);
      if (!fileInfo) continue;
      if (fileInfo.isSymbolicLink()) {
        errors.push(issue(filePath, undefined, "skill files must not be symlinks"));
        continue;
      }
      if (!fileInfo.isFile() || (fileName !== "SKILL.md" && fileName !== "SKILL.md.example")) {
        errors.push(issue(filePath, undefined, "a skill directory may contain only SKILL.md or SKILL.md.example"));
        continue;
      }
      const source = await readFile(filePath, "utf8").catch(() => null);
      if (source === null) {
        errors.push(issue(filePath, undefined, "cannot be read; check permissions"));
        continue;
      }
      validateFrontmatter(filePath, source, "skill", name, errors);
      scanCredentialAssignments(source, filePath, errors);
    }
    if (!skillNames.includes("SKILL.md") && !skillNames.includes("SKILL.md.example")) {
      errors.push(issue(join(path, "SKILL.md"), undefined, "is required for every skill"));
    }
  }
}

function componentFileName(name: string, extension: ".md" | ".ts"): { id: string; example: boolean } | null {
  const active = new RegExp(`^([a-z0-9][a-z0-9_-]{0,63})\\${extension}$`).exec(name);
  if (active) return { id: active[1], example: false };
  const example = new RegExp(`^([a-z0-9][a-z0-9_-]{0,63})\\${extension}\\.example$`).exec(name);
  return example ? { id: example[1], example: true } : null;
}

function validateFrontmatter(
  path: string,
  source: string,
  kind: "subagent" | "command" | "skill",
  expectedName: string,
  errors: ValidationIssue[],
): void {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    errors.push(issue(path, "frontmatter", "must start with ---"));
    return;
  }
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) {
    errors.push(issue(path, "frontmatter", "must have a closing ---"));
    return;
  }
  const body = lines.slice(1, end + 1).join("\n");
  let parsed: YamlValue;
  try {
    parsed = parseYaml(body);
  } catch {
    errors.push(issue(path, "frontmatter", "is not valid YAML"));
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(issue(path, "frontmatter", "must be a YAML mapping"));
    return;
  }
  scanStructuredCredentialValues(parsed, path, errors);
  if (kind === "command") {
    if (typeof parsed.description !== "string" || !parsed.description.trim()) {
      errors.push(issue(path, "description", "must be a non-empty string"));
    }
  } else {
    if (typeof parsed.name !== "string" || !parsed.name.trim()) {
      errors.push(issue(path, "name", "must be a non-empty string"));
    } else if (!isSafeIdentifier(parsed.name) || parsed.name !== expectedName) {
      errors.push(issue(path, "name", `must equal the safe component name '${expectedName}'`));
    }
    if (kind === "subagent" && (typeof parsed.description !== "string" || !parsed.description.trim())) {
      errors.push(issue(path, "description", "must be a non-empty string"));
    }
  }
  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    errors.push(issue(path, "description", "must be a string"));
  }
  if (kind === "subagent") {
    for (const field of ["tools", "spawns"] as const) {
      const value = parsed[field];
      if (value !== undefined && typeof value !== "string" && !Array.isArray(value)) {
        errors.push(issue(path, field, "must be a string or list of strings"));
      }
      if (Array.isArray(value) && value.some((item) => typeof item !== "string")) {
        errors.push(issue(path, field, "must contain only strings"));
      }
    }
  }
  if (lines.slice(end + 1).join("\n").trim().length === 0) {
    errors.push(issue(path, undefined, "must include a non-empty Markdown body after frontmatter"));
  }
}

async function validateYamlFile(
  path: string,
  label: string,
  errors: ValidationIssue[],
  validator?: (value: RecordValue, path: string, errors: ValidationIssue[]) => void,
): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return;
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) {
    errors.push(issue(path, undefined, "cannot be read; check permissions"));
    return;
  }
  try {
    const value = parseYaml(source);
    if (!isRecord(value)) errors.push(issue(path, undefined, `${label} must be a YAML mapping`));
    else validator?.(value, path, errors);
  } catch {
    errors.push(issue(path, undefined, `${label} is not valid YAML`));
  }
  scanCredentialAssignments(source, path, errors);
}

async function validateTextFile(
  path: string,
  label: string,
  errors: ValidationIssue[],
  validator: (source: string, path: string) => void,
): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return;
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) {
    errors.push(issue(path, undefined, `cannot read ${label}; check permissions`));
    return;
  }
  validator(source, path);
  scanCredentialAssignments(source, path, errors);
}

async function validateJsonFile(path: string, errors: ValidationIssue[]): Promise<void> {
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) {
    errors.push(issue(path, undefined, "cannot be read; check permissions"));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(issue(path, undefined, "must contain a JSON object"));
    }
  } catch {
    errors.push(issue(path, undefined, "is not valid JSON"));
  }
  scanCredentialAssignments(source, path, errors);
}

function validateAgentConfig(value: RecordValue, path: string, errors: ValidationIssue[]): void {
  if (value.setupVersion !== 1) errors.push(issue(path, "setupVersion", "must be the number 1"));
  if (value.modelRoles !== undefined) {
    if (!isRecord(value.modelRoles)) {
      errors.push(issue(path, "modelRoles", "must be a mapping of role names to model names"));
    } else {
      for (const [role, model] of Object.entries(value.modelRoles)) {
        if (!isSafeIdentifier(role) && !/^[a-z][a-zA-Z0-9_.-]*$/.test(role)) {
          errors.push(issue(path, `modelRoles.${role}`, "role name is unsafe"));
        }
        if (typeof model !== "string" || !model.trim() || model.includes("\n") || model.includes("\0") || model.includes("../")) {
          errors.push(issue(path, `modelRoles.${role}`, "must be a non-empty safe model name"));
        }
      }
    }
  }
}

function validateTypeScript(path: string, source: string, kind: "extension" | "tool", errors: ValidationIssue[]): void {
  const clean = stripCodeCommentsAndStrings(source);
  if (!/\bexport\s+default\b/.test(clean)) {
    errors.push(issue(path, "entrypoint", `must export a default ${kind} factory`));
  }
  const balance = balancedDelimiters(source);
  if (balance !== null) errors.push(issue(path, "syntax", balance));
  if (kind === "tool" && !/\bexecute\b/.test(clean)) {
    errors.push(issue(path, "entrypoint", "tool factory must define an execute handler"));
  }
  if (kind === "extension" && !/\b(?:function|=>)\b/.test(clean)) {
    errors.push(issue(path, "entrypoint", "extension must export a callable factory"));
  }
}

function stripCodeCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        state = "code";
        output += "\n";
      }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if ((state === "single" && character === "'") || (state === "double" && character === '"') || (state === "template" && character === "`")) {
        state = "code";
      }
      output += " ";
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line";
      index += 1;
      output += "  ";
    } else if (character === "/" && next === "*") {
      state = "block";
      index += 1;
      output += "  ";
    } else if (character === "'") {
      state = "single";
      output += " ";
    } else if (character === '"') {
      state = "double";
      output += " ";
    } else if (character === "`") {
      state = "template";
      output += " ";
    } else {
      output += character;
    }
  }
  return output;
}

function balancedDelimiters(source: string): string | null {
  const clean = stripCodeCommentsAndStrings(source);
  const stack: string[] = [];
  const opening = new Set(["{", "[", "("]);
  const closing: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  for (const character of clean) {
    if (opening.has(character)) stack.push(character);
    else if (character in closing) {
      if (stack.pop() !== closing[character]) return "has unbalanced delimiters; fix TypeScript syntax";
    }
  }
  return stack.length > 0 ? "has unbalanced delimiters; fix TypeScript syntax" : null;
}

type CredentialKeyClass = "api_token" | "token" | "secret" | "credential" | "api_key" | "app_key" | "client_secret" | "signing_secret" | "shared_secret" | "password" | "private_key" | "access_token" | "refresh_token" | "auth_token";

function scanCredentialAssignments(source: string, path: string, errors: ValidationIssue[]): void {
  const structured = /\.(?:json|ya?ml)(?:\.example)?$/i.test(path);
  if (structured) {
    try {
      scanStructuredCredentialValues(
        /\.(?:json)$/i.test(path) ? (JSON.parse(source) as YamlValue) : parseYaml(source),
        path,
        errors,
      );
    } catch {
      scanSourceAssignments(source, path, errors);
    }
  } else if (/\.ts(?:\.example)?$/i.test(path)) {
    scanSourceAssignments(source, path, errors);
  }
  if (SECRET_TOKEN.test(source)) reportCredentialIssue(path, "token", errors);
}

function scanStructuredCredentialValues(
  value: YamlValue,
  path: string,
  errors: ValidationIssue[],
  keyPath = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStructuredCredentialValues(item, path, errors, `${keyPath}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    const keyClass = credentialKeyClass(key);
    if (keyClass !== undefined && containsCredentialLiteral(child)) {
      reportCredentialIssue(path, keyClass, errors, childPath);
    }
    scanStructuredCredentialValues(child, path, errors, childPath);
  }
}

function containsCredentialLiteral(value: YamlValue): boolean {
  if (typeof value === "string") return isCredentialLiteral(value);
  return Array.isArray(value) && value.some((item) => containsCredentialLiteral(item));
}

function isCredentialLiteral(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && !ENV_REFERENCE.test(trimmed);
}

function credentialKeyClass(name: string): CredentialKeyClass | undefined {
  const normalized = name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized === "apitoken") return "api_token";
  if (normalized === "apikey") return "api_key";
  if (normalized === "appkey") return "app_key";
  if (normalized === "clientsecret") return "client_secret";
  if (normalized === "signingsecret") return "signing_secret";
  if (normalized === "sharedsecret") return "shared_secret";
  if (normalized === "password") return "password";
  if (normalized === "privatekey") return "private_key";
  if (normalized === "accesstoken") return "access_token";
  if (normalized === "refreshtoken") return "refresh_token";
  if (normalized === "authtoken" || normalized === "authenticationtoken") return "auth_token";
  if (/^(?:token|tokens|tokenkey|tokenvalue)$/.test(normalized)) return "token";
  if (/^(?:secret|secrets|secretkey|secretvalue)$/.test(normalized)) return "secret";
  if (/^(?:credential|credentials|credentialkey|credentialvalue)$/.test(normalized)) return "credential";
  return undefined;
}

function reportCredentialIssue(
  path: string,
  keyClass: CredentialKeyClass,
  errors: ValidationIssue[],
  keyPath?: string,
): void {
  const field = keyPath === undefined ? keyClass : `${keyClass} (${keyPath})`;
  const message = `contains a literal ${keyClass.replaceAll("_", " ")}; move the value to runtime configuration and commit only an environment reference`;
  if (errors.some((entry) => entry.path === path && entry.field === field && entry.message === message)) return;
  errors.push(issue(path, field, message));
}

function scanSourceAssignments(source: string, path: string, errors: ValidationIssue[]): void {
  const sourceWithoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of sourceWithoutComments.matchAll(SECRET_ASSIGNMENT)) {
    const key = match[1] ?? match[2] ?? match[3] ?? "";
    const value = (match[4] ?? match[5] ?? match[6] ?? "").trim();
    const keyClass = credentialKeyClass(key);
    const quoted = match[4] !== undefined || match[5] !== undefined;
    const literal = quoted || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value);
    if (keyClass !== undefined && literal && isCredentialLiteral(value)) reportCredentialIssue(path, keyClass, errors);
  }
}

function isTextPath(path: string): boolean {
  return /\.(?:md|ts|yml|yaml|json|env|txt)$/i.test(path);
}

function isRecord(value: YamlValue | unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPort(value: YamlValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function issue(path: string, field: string | undefined, message: string): ValidationIssue {
  return field === undefined ? { path, message } : { path, field, message };
}

function isCredentialName(name: string): boolean {
  return name in CREDENTIAL_ENV_NAMES || SECRET_ENV_NAME.test(name);
}

function parseDockerEnv(source: string, path: string, errors: ValidationIssue[]): EnvMap {
  const result: EnvMap = new Map();
  const lines = source.split(/\n/);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const equals = line.indexOf("=");
    const rawName = (equals < 0 ? line : line.slice(0, equals)).trim();
    if (!ENV_KEY.test(rawName)) {
      errors.push(issue(path, rawName || `line ${lineNumber}`, "must use Docker env-file syntax KEY=value without an export prefix"));
      return;
    }
    if (result.has(rawName)) {
      errors.push(issue(path, rawName, "is declared more than once; keep one runtime value"));
      return;
    }
    const rawValue = equals < 0 ? "" : line.slice(equals + 1);
    const parsed = parseEnvValue(rawValue);
    if (parsed.error !== undefined) {
      errors.push(issue(path, `${rawName} (line ${lineNumber})`, parsed.error));
      return;
    }
    result.set(rawName, { value: parsed.value, line: lineNumber, quoted: parsed.quoted });
  });
  return result;
}

function parseEnvValue(raw: string): { value: string; quoted: boolean; error?: string } {
  const value = raw.trimStart();
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") {
    const comment = value.search(/\s+#/);
    return { value: (comment < 0 ? value : value.slice(0, comment)).trimEnd(), quoted: false };
  }
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "\"" && escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      const trailing = value.slice(index + 1).trim();
      if (trailing && !trailing.startsWith("#")) return { value: "", quoted: true, error: "has trailing characters after a quoted value" };
      const inner = value.slice(1, index);
      return { value: quote === "\"" ? unescapeDockerDoubleQuoted(inner) : inner, quoted: true };
    }
  }
  return { value: "", quoted: true, error: `has an unterminated ${quote === "\"" ? "double" : "single"}-quoted value` };
}

function unescapeDockerDoubleQuoted(value: string): string {
  return value.replace(/\\([\\"nrt])/g, (_match, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    return character;
  });
}

function validateRuntimeEnv(
  env: EnvMap,
  source: string,
  envPath: string,
  agents: readonly AgentDirectory[],
  errors: ValidationIssue[],
): void {
  const value = (name: string): string | undefined => env.get(name)?.value.trim() || undefined;
  if (env.has("OMP_AGENTS")) errors.push(issue(envPath, "OMP_AGENTS", "is unsupported; direct agent directories are the only agent enumeration"));

  const brokerUrl = value("OMP_AUTH_BROKER_URL");
  const brokerToken = value("OMP_AUTH_BROKER_TOKEN");
  if ((brokerUrl && !brokerToken) || (!brokerUrl && brokerToken)) {
    errors.push(issue(envPath, "OMP_AUTH_BROKER_URL/OMP_AUTH_BROKER_TOKEN", "must be supplied together or both omitted"));
  }
  if (brokerUrl) validateUrl(envPath, "OMP_AUTH_BROKER_URL", brokerUrl, errors, false);

  for (const [name, entry] of env) {
    if (!entry.value.trim()) continue;
    if (name in URL_ENV_NAMES || name.endsWith("_BASE_URL")) {
      validateUrl(envPath, name, entry.value.trim(), errors, name === "PUMBLE_PUBLIC_BASE_URL");
    }
    if (name.endsWith("_PORT") || name === "PUMBLE_BRIDGE_PORT") {
      const parsed = Number(entry.value.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) errors.push(issue(envPath, name, "must be an integer from 1 through 65535"));
    }
  }

  const adapters = env.get("OMP_ADAPTERS");
  const pumbleAgent = value("PUMBLE_AGENT_ID");
  for (const required of PUMBLE_REQUIRED) {
    if (!value(required)) errors.push(issue(envPath, required, "is required for bundled Pumble startup; fill runtime.env from the adapter template"));
  }
  if (adapters && adapters.value.trim()) {
    const adapterLineCount = source.split(/\r?\n/).filter((line) => /^\s*OMP_ADAPTERS\s*=/.test(line)).length;
    if (adapters.quoted || adapterLineCount !== 1) {
      errors.push(issue(envPath, "OMP_ADAPTERS", "must be one unquoted JSON array on exactly one env-file line"));
    }
    if (pumbleAgent) errors.push(issue(envPath, "PUMBLE_AGENT_ID", "conflicts with OMP_ADAPTERS; choose one adapter registration mode"));
    validateAdaptersJson(adapters.value, envPath, agents, errors);
    validateOptionalPumbleValues(env, envPath, errors);
    return;
  }

  if (!pumbleAgent) errors.push(issue(envPath, "PUMBLE_AGENT_ID", "is required when OMP_ADAPTERS is unset; fill runtime.env from the adapter template"));
  if (pumbleAgent && !isSafeIdentifier(pumbleAgent)) errors.push(issue(envPath, "PUMBLE_AGENT_ID", "must be a safe agent id"));
  if (pumbleAgent && !agents.some((agent) => agent.id === pumbleAgent)) {
    errors.push(issue(envPath, "PUMBLE_AGENT_ID", `references '${pumbleAgent}', which is not a direct child of the effective agent collection`));
  }
  validateOptionalPumbleValues(env, envPath, errors);
}

function validateOptionalPumbleValues(env: EnvMap, envPath: string, errors: ValidationIssue[]): void {
  const publicUrl = env.get("PUMBLE_PUBLIC_BASE_URL")?.value.trim();
  if (publicUrl) validateUrl(envPath, "PUMBLE_PUBLIC_BASE_URL", publicUrl, errors, true);
  for (const name of ["PUMBLE_CORE_URL", "PUMBLE_CORE_CALLBACK_URL", "PUMBLE_API_BASE_URL", "PUMBLE_FILE_HOST_BASE_URL"] as const) {
    const value = env.get(name)?.value.trim();
    if (value) validateUrl(envPath, name, value, errors, false);
  }
}

function validateAdaptersJson(raw: string, envPath: string, agents: readonly AgentDirectory[], errors: ValidationIssue[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(issue(envPath, "OMP_ADAPTERS", "must be valid JSON containing an array of adapter registrations"));
    return;
  }
  if (!Array.isArray(parsed)) {
    errors.push(issue(envPath, "OMP_ADAPTERS", "must be a JSON array of adapter registrations"));
    return;
  }
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const field = `OMP_ADAPTERS[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(issue(envPath, field, "must be an object"));
      return;
    }
    const value = entry as Record<string, unknown>;
    for (const required of ["adapterId", "callbackUrl", "sharedSecret"] as const) {
      if (typeof value[required] !== "string" || !value[required].trim()) errors.push(issue(envPath, `${field}.${required}`, "must be a non-empty string"));
    }
    const adapterId = typeof value.adapterId === "string" ? value.adapterId : "";
    if (adapterId && seen.has(adapterId)) errors.push(issue(envPath, `${field}.adapterId`, "must be unique"));
    if (adapterId) seen.add(adapterId);
    if (typeof value.callbackUrl === "string" && value.callbackUrl.trim()) validateUrl(envPath, `${field}.callbackUrl`, value.callbackUrl.trim(), errors, false);
    if (value.agentId !== undefined) {
      if (typeof value.agentId !== "string" || !value.agentId.trim()) {
        errors.push(issue(envPath, `${field}.agentId`, "must be a non-empty safe agent id when supplied"));
      } else if (!isSafeIdentifier(value.agentId)) {
        errors.push(issue(envPath, `${field}.agentId`, "must be a safe agent id"));
      } else if (!agents.some((agent) => agent.id === value.agentId)) {
        errors.push(issue(envPath, `${field}.agentId`, `references '${value.agentId}', which is not a direct child of the effective agent collection`));
      }
    }
  });
}

function validateUrl(path: string, field: string, raw: string, errors: ValidationIssue[], secureOutsideLoopback: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(issue(path, field, "must be an absolute HTTP(S) URL"));
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") errors.push(issue(path, field, "must use HTTP or HTTPS"));
  if (secureOutsideLoopback && parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) errors.push(issue(path, field, "must use HTTPS outside localhost"));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
