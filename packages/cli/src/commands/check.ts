import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { optionString } from "../args.ts";
import { parseYaml } from "../config.ts";
import {
  expandModelPlaceholders,
  loadBundleModels,
  validateExpandedBaseUrl,
  type LoadedModelBundle,
  type ModelMetadata,
} from "../model-config.ts";
import {
  assertSafeRelativePath,
  isSafeIdentifier,
  resolveInside,
} from "../identifiers.ts";
import {
  PROJECT_CONFIG_FILE,
  resolveBundleRoot,
  resolveCommandPath,
  resolveDefaultEnvFile,
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
  readonly envFile?: string;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly project: ProjectContext;
  readonly agent: AgentDirectory;
  readonly agents: readonly [AgentDirectory];
  readonly models: readonly ModelMetadata[];
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly credentialNames: readonly string[];
  readonly envFile?: string;
}

export interface BuildValidation {
  readonly result: CheckResult;
  readonly modelBundle: LoadedModelBundle;
}


const PROJECT_KEYS: Record<string, true> = { version: true, agent: true, image: true, run: true, files: true };
const AGENT_KEYS: Record<string, true> = { id: true };
const IMAGE_KEYS: Record<string, true> = { tag: true };
const RUN_KEYS: Record<string, true> = { dataVolume: true, corePort: true, adapterPort: true };
const FILE_KEYS: Record<string, true> = { env: true, path: true, mode: true };
const OMP_REQUIRED_FILES = ["AGENTS.md", "config.yml"] as const;
const SECRET_ENV_NAME = /(?:API_KEY|APP_KEY|CLIENT_SECRET|SIGNING_SECRET|SHARED_SECRET|AUTH_BROKER_TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|TOKEN)$/i;
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/;
const SECRET_ASSIGNMENT = /(?:\b(?:const|let|var)\s+|(?:^|[,{.;(])\s*|\.)(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$-]*))\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|(\$\{[^}]*\}|[^\s,;}]+))/gm;
const ENV_REFERENCE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|(?:process\.env|env)\.[A-Za-z_][A-Za-z0-9_]*)$/;
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
};
const CREDENTIAL_ENV_NAMES: Record<string, true> = {
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_HTTP_API_TOKEN: true,
  OMP_ADAPTERS: true,
  CLIPROXY_API_KEY: true,
  OLLAMA_CLOUD_API_KEY: true,
  OPENCODE_GO_API_KEY: true,
  PUMBLE_APP_CLIENT_SECRET: true,
  PUMBLE_APP_KEY: true,
  PUMBLE_APP_SIGNING_SECRET: true,
  PUMBLE_CORE_SHARED_SECRET: true,
};
const FIXED_LISTENER_ENV: Record<string, true> = {
  OMP_HOST: true,
  OMP_PORT: true,
  OMP_HTTP_HOST: true,
  OMP_HTTP_PORT: true,
  PUMBLE_BRIDGE_HOST: true,
  PUMBLE_BRIDGE_PORT: true,
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
  const { result } = await validateBundleForBuild(options);
  return result;
}

export async function validateBundleForBuild(options: CheckOptions): Promise<BuildValidation> {
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
    errors.push(issue(configPath, undefined, "is missing; create omp-bundler.yml with version: 1 and agent.id"));
  } else if (!configStat.isFile()) {
    errors.push(issue(configPath, undefined, "must be a regular file"));
  } else {
    try {
      parsedConfig = parseYaml(await readFile(configPath, "utf8"));
    } catch {
      errors.push(issue(configPath, undefined, "is not valid YAML; fix its syntax without committing credentials"));
    }
  }

  const dockerfilePath = join(rootDir, "Dockerfile");
  const dockerfileStat = await lstat(dockerfilePath).catch(() => null);
  if (!dockerfileStat) errors.push(issue(dockerfilePath, undefined, "is missing; every bundle owns its Dockerfile"));
  else if (dockerfileStat.isSymbolicLink()) errors.push(issue(dockerfilePath, undefined, "must not be a symlink"));
  else if (!dockerfileStat.isFile()) errors.push(issue(dockerfilePath, undefined, "must be a regular file"));
  const projectInfo = buildProjectContext(rootDir, configPath, parsedConfig, errors);
  const agents = [projectInfo.project.agent] as [AgentDirectory];
  await validateAgent(projectInfo.project.agent, errors);
  await validateSchedulesDirectory(rootDir, errors);
  const filesConfig: unknown = projectInfo.project.config.files;
  if (Array.isArray(filesConfig)) {
    for (const entry of filesConfig) {
      if (isRecord(entry) && typeof entry.env === "string") credentialNames.add(entry.env);
    }
  }

  let modelBundle: LoadedModelBundle = {
    catalog: { providers: {} },
    source: "providers: {}\n",
    connections: [],
    metadata: [],
    envNames: [],
  };
  try {
    modelBundle = await loadBundleModels(rootDir, agents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const separator = message.indexOf(": ");
    errors.push(issue(
      separator >= 0 ? message.slice(0, separator) : rootDir,
      undefined,
      separator >= 0 ? message.slice(separator + 2) : message,
    ));
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
        for (const name of modelBundle.envNames) {
          if (!parsedEnv.get(name)?.value.trim()) {
            errors.push(issue(resolvedEnvFile, name, "is required by model configuration and must be non-empty"));
          }
        }
        const modelEnv = new Map<string, string>();
        for (const name of modelBundle.envNames) {
          const value = parsedEnv.get(name)?.value.trim();
          if (value) modelEnv.set(name, value);
        }
        for (const connection of modelBundle.connections) {
          const baseUrl = expandModelPlaceholders(connection.baseUrl, modelEnv, `${resolvedEnvFile} [${connection.selector}]`);
          if (baseUrl.includes("${")) continue;
          try {
            validateExpandedBaseUrl(baseUrl, `${resolvedEnvFile} [${connection.selector}]`);
          } catch {
            errors.push(issue(resolvedEnvFile, connection.selector, "model baseUrl must resolve to an absolute HTTP(S) URL"));
          }
        }
        validateRuntimeEnv(parsedEnv, envSource, resolvedEnvFile, agents, errors);
      }
    }
  }

  return {
    result: {
      ok: errors.length === 0,
      project: projectInfo.project,
      agent: projectInfo.project.agent,
      agents,
      models: modelBundle.metadata,
      errors,
      warnings,
      credentialNames: [...credentialNames].sort(),
      ...(resolvedEnvFile === undefined ? {} : { envFile: resolvedEnvFile }),
    },
    modelBundle,
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
  // Explicit --env-file always wins; otherwise use the bundle's runtime.env
  // if it exists, and fall back to structural-only validation when absent.
  let effectiveEnvFile = envFile;
  if (effectiveEnvFile === undefined) {
    const bundleRoot = await resolveBundleRoot(
      args.positionals[0] === undefined ? undefined : args.positionals[0],
      context.cwd,
    );
    effectiveEnvFile = await resolveDefaultEnvFile(bundleRoot);
  }

  const result = await validateBundle({
    cwd: context.cwd,
    ...(args.positionals[0] === undefined ? {} : { bundlePath: args.positionals[0] }),
    ...(effectiveEnvFile === undefined ? {} : { envFile: effectiveEnvFile }),
  });
  const output = context.io.stdout;
  output.write(`Bundle: ${result.project.rootDir}\n`);
  output.write(`Agent: ${result.agent.id}\n`);
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
  const fallbackAgent: AgentDirectory = { id: "invalid", path: rootDir };
  const fallbackConfig: ProjectConfig = {
    version: 1,
    agent: { id: fallbackAgent.id },
  };
  if (!isRecord(parsed)) {
    if (parsed !== undefined) errors.push(issue(configPath, undefined, "must contain a YAML mapping"));
    return {
      project: {
        rootDir,
        configPath,
        config: fallbackConfig,
        agent: fallbackAgent,
      },
      config: undefined,
    };
  }
  validateProjectConfig(parsed, configPath, rootDir, errors);
  const agentRecord = isRecord(parsed.agent) ? parsed.agent : undefined;
  const agentId = typeof agentRecord?.id === "string" && agentRecord.id.trim()
    ? agentRecord.id
    : fallbackAgent.id;
  return {
    project: {
      rootDir,
      configPath,
      config: parsed as unknown as ProjectConfig,
      agent: { id: agentId, path: rootDir },
    },
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
  if (value.version !== 1) errors.push(issue(path, "version", "must be the number 1"));
  if (!isRecord(value.agent)) {
    errors.push(issue(path, "agent", "must be a mapping with an id"));
  } else {
    validateMapping(value.agent, path, "agent", AGENT_KEYS, errors);
    if (typeof value.agent.id !== "string" || !value.agent.id.trim()) {
      errors.push(issue(path, "agent.id", "must be a non-empty safe identifier"));
    } else if (!COMPONENT_ID.test(value.agent.id)) {
      errors.push(issue(path, "agent.id", "must use 1-64 lowercase letters, numbers, '-' or '_' and start with a letter or number"));
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
      if (validPort(value.run.corePort) && validPort(value.run.adapterPort) && value.run.corePort === value.run.adapterPort) {
        errors.push(issue(path, "run.corePort/run.adapterPort", "must be distinct host ports"));
      }
    }
  }
  if (value.files !== undefined) validateFilesConfig(value.files, path, errors);
  if (isRecord(value.image) && value.image.tag !== undefined && (
    typeof value.image.tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.image.tag) || value.image.tag.includes("..")
  )) {
    errors.push(issue(path, "image.tag", "must be a safe Docker image tag without traversal, whitespace, or shell expansion"));
  }
}

function validateFilesConfig(
  value: YamlValue,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    errors.push(issue(path, "files", "must be an array"));
    return;
  }
  const seenPaths = new Set<string>();
  value.forEach((entry, index) => {
    const field = `files[${index}]`;
    if (!isRecord(entry)) {
      errors.push(issue(path, field, "must be a mapping"));
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!(key in FILE_KEYS)) errors.push(issue(path, `${field}.${key}`, "is not a supported field"));
    }

    if (typeof entry.env !== "string" || !entry.env.trim()) {
      errors.push(issue(path, `${field}.env`, "must be a non-empty environment variable name"));
    } else if (!ENV_KEY.test(entry.env)) {
      errors.push(issue(path, `${field}.env`, "must be a valid environment variable name"));
    }

    if (typeof entry.path !== "string" || !entry.path) {
      errors.push(issue(path, `${field}.path`, "must be a non-empty absolute path"));
    } else {
      if (seenPaths.has(entry.path)) {
        errors.push(issue(path, `${field}.path`, "must be unique across files entries"));
      } else {
        seenPaths.add(entry.path);
      }
      if (!isAbsolute(entry.path)) {
        errors.push(issue(path, `${field}.path`, "must be an absolute path"));
      } else if (entry.path === "/data" || entry.path.startsWith("/data/")) {
        errors.push(issue(path, `${field}.path`, "must not be under /data"));
      } else if (
        entry.path === "/agent" ||
        entry.path.startsWith("/agent/") ||
        entry.path === "/app" ||
        entry.path.startsWith("/app/")
      ) {
        errors.push(issue(path, `${field}.path`, "must not target reserved bundler paths /agent or /app"));
      }
    }

    if (
      entry.mode !== undefined &&
      (typeof entry.mode !== "string" || !/^0?[0-7]{3,4}$/.test(entry.mode))
    ) {
      errors.push(issue(path, `${field}.mode`, "must be an octal mode with 3 or 4 digits"));
    }
  });
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


async function validateAgent(
  agent: AgentDirectory,
  errors: ValidationIssue[],
): Promise<void> {

  await validateTextFile(join(agent.path, "AGENTS.md"), "instructions", errors, (source, path) => {
    if (!source.trim()) errors.push(issue(path, undefined, "must not be empty"));
  });
  await validateYamlFile(join(agent.path, "config.yml"), "agent config", errors, validateAgentConfig);
  const settingsPath = join(agent.path, "settings.json");
  const settings = await lstat(settingsPath).catch(() => null);
  if (settings?.isFile()) await validateJsonFile(settingsPath, errors);
  await validateComponents(agent, errors);
}


async function validateComponents(agent: AgentDirectory, errors: ValidationIssue[]): Promise<void> {
  await validateMarkdownDirectory(join(agent.path, "subagents"), "subagents", errors);
  await validateMarkdownDirectory(join(agent.path, "commands"), "commands", errors);
  await validateTypeScriptDirectory(join(agent.path, "extensions"), "extension", errors);
  await validateTypeScriptDirectory(join(agent.path, "tools"), "tool", errors);
  await validateSkillsDirectory(join(agent.path, "skills"), errors);
}

/**
 * Validate the bundle-root `schedules/` directory of cron job YAML files.
 * `*.yml` are active; `*.example` (and any other suffix) are inert. Schedules
 * live at the bundle root, not under the agent `.omp` surface, so this is
 * separate from {@link validateComponents}.
 */
async function validateSchedulesDirectory(
  bundleRoot: string,
  errors: ValidationIssue[],
): Promise<void> {
  const directory = join(bundleRoot, "schedules");
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return;
  const names = await readdir(directory).catch(() => [] as string[]);
  const seen = new Set<string>();
  for (const name of names.sort()) {
    const path = join(directory, name);
    const entry = await lstat(path).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      errors.push(issue(path, undefined, "schedule files must not be symlinks"));
      continue;
    }
    if (!entry.isFile()) {
      errors.push(issue(path, undefined, "schedule entries must be regular files"));
      continue;
    }
    const parsed = componentFileName(name, ".yml");
    if (!parsed || parsed.example) continue; // inert (e.g. *.yml.example) or unrelated: ignore
    if (seen.has(parsed.id)) {
      errors.push(issue(path, "schedule name", `duplicates active schedule '${parsed.id}'`));
    }
    seen.add(parsed.id);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) {
      errors.push(issue(path, undefined, "cannot be read; check file permissions"));
      continue;
    }
    validateScheduleFile(path, source, parsed.id, errors);
  }
}

/** Validate one cron schedule YAML body against the job schema. */
function validateScheduleFile(
  path: string,
  source: string,
  expectedId: string,
  errors: ValidationIssue[],
): void {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch {
    errors.push(issue(path, undefined, "schedule is not valid YAML"));
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(issue(path, undefined, "schedule must be a YAML mapping"));
    return;
  }
  if (typeof parsed.schedule !== "string" || !parsed.schedule.trim()) {
    errors.push(issue(path, "schedule", "must be a non-empty 5-field cron expression"));
  } else if (!CRON_FIELD_RE.test(parsed.schedule.trim())) {
    errors.push(issue(path, "schedule", "must be a 5-field cron expression (minute hour day month weekday)"));
  }
  if (parsed.timezone !== undefined) {
    if (typeof parsed.timezone !== "string" || !parsed.timezone.trim()) {
      errors.push(issue(path, "timezone", "must be a non-empty IANA timezone"));
    } else if (!isValidTimezone(parsed.timezone.trim())) {
      errors.push(issue(path, "timezone", "must be a valid IANA timezone (e.g. America/New_York)"));
    }
  }
  if (parsed.missed !== "skip" && parsed.missed !== "catchUp") {
    errors.push(issue(path, "missed", "must be 'skip' or 'catchUp'"));
  }
  const prompt = parsed.prompt;
  const command = parsed.command;
  const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
  const hasCommand = typeof command === "string" && command.trim().length > 0;
  if (prompt !== undefined && !hasPrompt) {
    errors.push(issue(path, "prompt", "must be a non-empty string"));
  }
  if (command !== undefined && !hasCommand) {
    errors.push(issue(path, "command", "must be a non-empty string"));
  }
  if (hasPrompt && hasCommand) {
    errors.push(issue(path, undefined, "exactly one of prompt or command is required"));
  } else if (!hasPrompt && !hasCommand && prompt === undefined && command === undefined) {
    errors.push(issue(path, undefined, "exactly one of prompt or command is required"));
  }
  if (parsed.timeout !== undefined) {
    if (!hasCommand) {
      errors.push(issue(path, "timeout", "is only valid with command"));
    } else if (!isPositiveFiniteInteger(parsed.timeout)) {
      errors.push(issue(path, "timeout", "must be a positive finite integer"));
    }
  }
  scanCredentialAssignments(source, path, errors);
  void expectedId;
}

/** A 5-field cron expression: minute hour day-of-month month day-of-week. */
const CRON_FIELD_RE =
  /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/** True when a YAML scalar is a positive finite integer. */
function isPositiveFiniteInteger(value: YamlValue): boolean {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && Number.isInteger(number) && number > 0;
}

/** True when `tz` is a valid IANA timezone Intl can format. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function validateMarkdownDirectory(
  directory: string,
  kind: "subagents" | "commands",
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
    validateFrontmatter(path, source, kind === "subagents" ? "subagent" : "command", parsed.id, errors);
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
    let foundManifest = false;
    for (const fileName of ["SKILL.md", "SKILL.md.example"]) {
      const filePath = join(path, fileName);
      const fileInfo = await lstat(filePath).catch(() => null);
      if (!fileInfo) continue;
      foundManifest = true;
      if (fileInfo.isSymbolicLink()) {
        errors.push(issue(filePath, undefined, "skill manifests must not be symlinks"));
        continue;
      }
      if (!fileInfo.isFile()) {
        errors.push(issue(filePath, undefined, "skill manifests must be regular files"));
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
    if (!foundManifest) {
      errors.push(issue(join(path, "SKILL.md"), undefined, "is required for every skill"));
    }
  }
}

function componentFileName(name: string, extension: ".md" | ".ts" | ".yml"): { id: string; example: boolean } | null {
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

export function getDockerEnvValue(source: string, path: string, name: string): string | undefined {
  const errors: ValidationIssue[] = [];
  const value = parseDockerEnv(source, path, errors).get(name)?.value;
  if (errors.length > 0) throw new Error(`${path}: ${formatIssue(errors[0])}`);
  return value;
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
  for (const [name] of env) {
    if (name in FIXED_LISTENER_ENV) {
      errors.push(issue(envPath, name, "is fixed inside the container; configure host ports with run.corePort and run.adapterPort"));
    }
  }

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
    if ((name.endsWith("_PORT") || name === "PUMBLE_BRIDGE_PORT") && !(name in FIXED_LISTENER_ENV)) {
      const parsed = Number(entry.value.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) errors.push(issue(envPath, name, "must be an integer from 1 through 65535"));
    }
  }

  const adapterMode = value("OMP_BUNDLER_ADAPTER") || "http";
  if (adapterMode !== "http" && adapterMode !== "pumble") {
    errors.push(issue(envPath, "OMP_BUNDLER_ADAPTER", "must be 'http' or 'pumble'"));
    return;
  }
  const turnTimeout = value("OMP_HTTP_TURN_TIMEOUT_MS");
  if (turnTimeout !== undefined) {
    const parsed = Number(turnTimeout);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      errors.push(issue(envPath, "OMP_HTTP_TURN_TIMEOUT_MS", "must be a positive integer"));
    }
  }

  if (env.has("PUMBLE_AGENT_ID")) {
    errors.push(issue(envPath, "PUMBLE_AGENT_ID", "is unsupported; the project agent.id is registered automatically"));
  }
  const adapters = env.get("OMP_ADAPTERS");
  if (adapters !== undefined) {
    if (!adapters.value.trim()) {
      errors.push(issue(envPath, "OMP_ADAPTERS", "must not be empty when explicitly set"));
    } else {
      const adapterLineCount = source.split(/\r?\n/).filter((line) => /^\s*OMP_ADAPTERS\s*=/.test(line)).length;
      if (adapters.quoted || adapterLineCount !== 1) {
        errors.push(issue(envPath, "OMP_ADAPTERS", "must be one unquoted JSON array on exactly one env-file line"));
      }
      validateAdaptersJson(
        adapters.value,
        envPath,
        agents,
        adapterMode,
        adapterMode === "pumble" ? value("PUMBLE_ADAPTER_ID") ?? "pumble" : undefined,
        errors,
      );
    }
  }
  if (adapterMode === "http") return;

  for (const required of PUMBLE_REQUIRED) {
    if (!value(required)) errors.push(issue(envPath, required, "is required for bundled Pumble startup; fill runtime.env from the adapter template"));
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

function validateAdaptersJson(
  raw: string,
  envPath: string,
  agents: readonly AgentDirectory[],
  adapterMode: "http" | "pumble",
  expectedAdapterId: string | undefined,
  errors: ValidationIssue[],
): void {
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
  if (parsed.length !== 1) {
    errors.push(issue(envPath, "OMP_ADAPTERS", "must contain exactly one adapter registration"));
    return;
  }
  const expectedAgentId = agents[0]?.id;
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
    if (expectedAdapterId !== undefined && adapterId && adapterId !== expectedAdapterId) {
      errors.push(issue(
        envPath,
        `${field}.adapterId`,
        `must match PUMBLE_ADAPTER_ID '${expectedAdapterId}' for the pumble adapter`,
      ));
    }
    if (typeof value.callbackUrl === "string" && value.callbackUrl.trim()) {
      const callbackUrl = validateUrl(envPath, `${field}.callbackUrl`, value.callbackUrl.trim(), errors, false);
      if (callbackUrl !== undefined) {
        const expectedPath = adapterMode === "http"
          ? `/core/events/${expectedAgentId ?? "<missing>"}`
          : "/core/events";
        if (callbackUrl.pathname !== expectedPath) {
          errors.push(issue(envPath, `${field}.callbackUrl`, `must target '${expectedPath}' for the ${adapterMode} adapter`));
        }
      }
    }
    if (typeof value.agentId !== "string" || !value.agentId.trim()) {
      errors.push(issue(envPath, `${field}.agentId`, "is required and must be a non-empty safe agent id"));
    } else if (!isSafeIdentifier(value.agentId)) {
      errors.push(issue(envPath, `${field}.agentId`, "must be a safe agent id"));
    } else if (value.agentId !== expectedAgentId) {
      errors.push(issue(envPath, `${field}.agentId`, `must match the configured root agent '${expectedAgentId ?? "<missing>"}'`));
    }
  });
}

function validateUrl(
  path: string,
  field: string,
  raw: string,
  errors: ValidationIssue[],
  secureOutsideLoopback: boolean,
): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(issue(path, field, "must be an absolute HTTP(S) URL"));
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(issue(path, field, "must use HTTP or HTTPS"));
    return undefined;
  }
  if (secureOutsideLoopback && parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
    errors.push(issue(path, field, "must use HTTPS outside localhost"));
  }
  return parsed;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
