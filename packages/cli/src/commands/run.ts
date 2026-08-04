import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { optionBoolean } from "../args.ts";
import { executeChild } from "../process.ts";
import { resolveBundleRoot, resolveDefaultEnvFile } from "../project.ts";
import { validateBundle, formatIssue } from "./check.ts";
import { assertAllowedOptions, requiredOptionString } from "./common.ts";
import {
  BUNDLE_ROOT_LABEL,
  formatDockerCommand,
  runDockerArgs,
  shellQuote,
} from "./docker.ts";
import type { CheckResult } from "./check.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";

export const RUN_HELP = `omp-bundler run [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]

Validate runtime bindings, then run the configured image in the foreground with
its ports and named data volume. If the detached service is already running,
choose whether to follow its logs, replace it with this foreground run, or
cancel. --env-file defaults to the bundle's runtime.env.
--dry-run prints the Docker command without executing it.`;

const SAFE_IMAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export interface RunSettings {
  readonly image: string;
  readonly corePort: number;
  readonly adapterPort: number;
  readonly dataVolume: string;
  readonly containerName: string;
  readonly bundleRoot: string;
}

export const runCommand: CommandHandler = async (
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> => runBundle(args, context, false);

export async function runBundle(
  args: ParsedArguments,
  context: CommandContext,
  detached: boolean,
): Promise<number> {
  if (args.options.help === true) {
    context.io.stdout.write(`${RUN_HELP}\n`);
    return 0;
  }
  if (args.options.help !== undefined) {
    return usageError(context, "--help does not accept a value");
  }

  try {
    assertAllowedOptions(args, ["env-file", "image", "dry-run"]);
  } catch (error) {
    return usageError(context, error instanceof Error ? error.message : String(error));
  }
  if (args.positionals.length > 1) {
    return usageError(context, "accepts at most one bundle path");
  }
  if (args.options["dry-run"] !== undefined && !optionBoolean(args, "dry-run")) {
    return usageError(context, "--dry-run does not accept a value");
  }

  let envFile: string | undefined;
  if (args.options["env-file"] !== undefined) {
    try {
      envFile = requiredOptionString(args, "env-file");
    } catch (error) {
      return usageError(context, error instanceof Error ? error.message : String(error));
    }
  } else {
    const bundleRoot = await resolveBundleRoot(
      args.positionals[0] === undefined ? undefined : args.positionals[0],
      context.cwd,
    );
    envFile = await resolveDefaultEnvFile(bundleRoot);
    if (envFile === undefined) {
      return usageError(context, `runtime env-file is missing: ${join(bundleRoot, "runtime.env")}; copy runtime.env.example to runtime.env`);
    }
  }

  let imageOverride: string | undefined;
  if (args.options.image !== undefined) {
    try {
      imageOverride = requiredOptionString(args, "image");
    } catch (error) {
      return usageError(context, error instanceof Error ? error.message : String(error));
    }
    if (!isSafeImageTag(imageOverride)) {
      return usageError(context, "--image must be a safe Docker image tag");
    }
  }

  const result = await validateBundle({
    cwd: context.cwd,
    ...(args.positionals[0] === undefined ? {} : { bundlePath: args.positionals[0] }),
    envFile,
  });
  if (!result.ok) {
    writeValidationErrors(context, result);
    return 1;
  }
  if (result.envFile === undefined) {
    return usageError(context, "--env-file was not resolved");
  }

  const configuredSettings = resolveRunSettings(result, imageOverride);

  if (optionBoolean(args, "dry-run")) {
    const settings = await resolveAvailableRunSettings(configuredSettings);
    printPortSelection(context, configuredSettings, settings);
    context.io.stdout.write(`${runPreviewCommand(settings, result.envFile, detached)}\n`);
    return 0;
  }

  if (detached) {
    const existingState = await inspectBundleServiceContainer(configuredSettings);
    if (existingState === "running") {
      context.io.stdout.write(`Service ${configuredSettings.containerName}: already running\n`);
      const livePort = await inspectPublishedPort(configuredSettings.containerName, 8765)
        ?? configuredSettings.adapterPort;
      printAgentEndpoints(context, result, configuredSettings, livePort);
      return 0;
    }
    if (existingState !== undefined) {
      const removal = await executeChild("docker", ["rm", "-f", configuredSettings.containerName], {
        stdio: "pipe",
        forwardSignals: false,
      });
      if (removal.exitCode !== 0) {
        context.io.stderr.write(removal.stderr || `docker rm failed with exit code ${removal.exitCode}\n`);
        return removal.exitCode;
      }
    }
  } else {
    const conflictResult = await resolveServiceConflict(context, configuredSettings);
    if (conflictResult !== undefined) return conflictResult;
  }

  let preferredSettings = configuredSettings;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const settings = await resolveAvailableRunSettings(preferredSettings);
    printPortSelection(context, preferredSettings, settings);
    const { containerName, ...containerSettings } = settings;
    const dockerArgs = runDockerArgs({
      ...containerSettings,
      envFile: result.envFile,
      ...(detached ? { detached: true, containerName } : {}),
    });

    if (!detached) printAgentEndpoints(context, result, settings, undefined, true);
    const docker = await executeChild("docker", dockerArgs, detached
      ? { stdio: "pipe", forwardSignals: false }
      : {
        stdio: "inherit",
        forwardSignals: true,
        signalMap: { SIGTERM: "SIGINT" },
      });
    if (docker.exitCode === 0) {
      if (detached) {
        context.io.stdout.write(`Started service ${containerName}.\n`);
        printAgentEndpoints(context, result, settings);
      }
      return 0;
    }

    const retrySettings = await resolveAvailableRunSettings(settings);
    const portChanged = retrySettings.adapterPort !== settings.adapterPort
      || retrySettings.corePort !== settings.corePort;
    if (!portChanged || attempt === 5) {
      if (detached) {
        context.io.stderr.write(docker.stderr || `docker run failed with exit code ${docker.exitCode}\n`);
      }
      return docker.exitCode;
    }

    context.io.stderr.write("A selected host port became busy during Docker startup; retrying with free ports.\n");
    printPortSelection(context, settings, retrySettings);
    preferredSettings = retrySettings;
  }
  return 1;
}

export function resolveRunSettings(
  result: Pick<CheckResult, "project">,
  imageOverride?: string,
): RunSettings {
  const bundleName = basename(result.project.rootDir);
  const configuredImage = result.project.config.image?.tag;
  const configuredRun = result.project.config.run;
  const image = imageOverride
    ?? (typeof configuredImage === "string" && configuredImage.trim() ? configuredImage : `${bundleName}:local`);
  const dataVolume = typeof configuredRun?.dataVolume === "string" && configuredRun.dataVolume.trim()
    ? configuredRun.dataVolume
    : `${bundleName}-data`;
  const corePort = typeof configuredRun?.corePort === "number" ? configuredRun.corePort : 8787;
  const adapterPort = typeof configuredRun?.adapterPort === "number" ? configuredRun.adapterPort : 8765;
  const containerName = `${dataVolume}-service`;

  if (!isSafeImageTag(image)) throw new Error(`image tag is not safe for Docker: ${image}`);
  if (!SAFE_VOLUME_NAME.test(dataVolume)) throw new Error(`data volume is not safe for Docker: ${dataVolume}`);
  if (!SAFE_CONTAINER_NAME.test(containerName)) throw new Error(`service container name is not safe for Docker: ${containerName}`);
  if (!Number.isSafeInteger(corePort) || corePort < 1 || corePort > 65535) {
    throw new Error(`core port is not valid: ${corePort}`);
  }
  if (!Number.isSafeInteger(adapterPort) || adapterPort < 1 || adapterPort > 65535) {
    throw new Error(`adapter port is not valid: ${adapterPort}`);
  }
  return { image, dataVolume, corePort, adapterPort, containerName, bundleRoot: result.project.rootDir };
}
export type PortProbe = (port: number) => Promise<boolean>;

export async function resolveAvailablePorts(
  corePort: number,
  adapterPort: number,
  probe: PortProbe = isPortAvailable,
): Promise<Pick<RunSettings, "corePort" | "adapterPort">> {
  const selectedAdapterPort = await findAvailablePort(adapterPort, new Set(), probe);
  const selectedCorePort = await findAvailablePort(corePort, new Set([selectedAdapterPort]), probe);
  return { adapterPort: selectedAdapterPort, corePort: selectedCorePort };
}

export async function resolveAvailableRunSettings(
  settings: RunSettings,
  probe: PortProbe = isPortAvailable,
): Promise<RunSettings> {
  const ports = await resolveAvailablePorts(settings.corePort, settings.adapterPort, probe);
  return ports.adapterPort === settings.adapterPort && ports.corePort === settings.corePort
    ? settings
    : { ...settings, ...ports };
}

export async function discoverPublishedAdapterPort(
  bundleRoot: string,
  containerName: string,
): Promise<number | undefined> {
  try {
    const named = await inspectContainerIdentity(containerName);
    if (named?.status === "running" && named.bundleRoot === bundleRoot) {
      const namedPort = await inspectPublishedPort(containerName, 8765);
      if (namedPort !== undefined) return namedPort;
    }

    const containers = await executeChild(
      "docker",
      ["ps", "--filter", `label=${BUNDLE_ROOT_LABEL}=${bundleRoot}`, "--format", "{{.ID}}"],
      { stdio: "pipe", forwardSignals: false },
    );
    if (containers.exitCode !== 0) return undefined;
    for (const id of containers.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const identity = await inspectContainerIdentity(id);
      if (identity?.status !== "running" || identity.bundleRoot !== bundleRoot) continue;
      const port = await inspectPublishedPort(id, 8765);
      if (port !== undefined) return port;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function isPortAvailable(port: number): Promise<boolean> {
  const { promise, resolve: complete } = Promise.withResolvers<boolean>();
  const server = createServer();
  let settled = false;
  const finish = (available: boolean): void => {
    if (settled) return;
    settled = true;
    complete(available);
  };
  server.unref();
  server.once("error", () => finish(false));
  server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
    server.close((error) => finish(error === undefined));
  });
  return promise;
}

async function findAvailablePort(
  preferred: number,
  excluded: ReadonlySet<number>,
  probe: PortProbe,
): Promise<number> {
  for (let offset = 0; offset < 65_535; offset += 1) {
    const candidate = ((preferred - 1 + offset) % 65_535) + 1;
    if (!excluded.has(candidate) && await probe(candidate)) return candidate;
  }
  throw new Error("no host TCP port is available");
}

export function runPreviewCommand(
  settings: RunSettings,
  envFile: string,
  detached = false,
): string {
  const { containerName, ...containerSettings } = settings;
  return formatDockerCommand("docker", runDockerArgs({
    ...containerSettings,
    envFile,
    ...(detached ? { detached: true, containerName } : {}),
  }));
}

async function resolveServiceConflict(
  context: CommandContext,
  settings: RunSettings,
): Promise<number | undefined> {
  const { containerName } = settings;
  if (await inspectBundleServiceContainer(settings) !== "running") return undefined;

  context.io.stdout.write(`Service ${containerName} is already running.\n`);
  if (!("isTTY" in context.io.stdin) || context.io.stdin.isTTY !== true) {
    context.io.stderr.write(
      "Run this command in an interactive terminal to choose an action, or stop the service with 'omp-bundler service stop'.\n",
    );
    return 1;
  }

  const readline = createInterface({ input: context.io.stdin, output: context.io.stdout });
  let choice: string;
  try {
    while (true) {
      choice = (await readline.question(
        "[f] Follow service logs  [r] Stop service and run in foreground  [c] Cancel (default: f): ",
      )).trim().toLowerCase();
      if (choice === "" || choice === "f" || choice === "follow") {
        choice = "follow";
        break;
      }
      if (choice === "r" || choice === "run" || choice === "replace") {
        choice = "replace";
        break;
      }
      if (choice === "c" || choice === "cancel") {
        choice = "cancel";
        break;
      }
      context.io.stdout.write("Choose f, r, or c.\n");
    }
  } finally {
    readline.close();
  }

  if (choice === "cancel") return 0;
  if (choice === "follow") {
    const logs = await executeChild("docker", ["logs", "--follow", containerName], {
      stdio: "inherit",
      forwardSignals: true,
    });
    return logs.exitCode;
  }

  const stopped = await executeChild("docker", ["stop", containerName], {
    stdio: "pipe",
    forwardSignals: false,
  });
  if (stopped.exitCode !== 0) {
    context.io.stderr.write(stopped.stderr || `docker stop failed with exit code ${stopped.exitCode}\n`);
    return stopped.exitCode;
  }
  context.io.stdout.write(`Stopped service ${containerName}; starting foreground run.\n`);
  return undefined;
}

interface ContainerIdentity {
  readonly status: string;
  readonly bundleRoot?: string;
}

export async function inspectBundleServiceContainer(
  settings: Pick<RunSettings, "containerName" | "bundleRoot">,
): Promise<string | undefined> {
  const identity = await inspectContainerIdentity(settings.containerName);
  if (identity === undefined) return undefined;
  if (identity.bundleRoot !== settings.bundleRoot) {
    throw new Error(
      `service container '${settings.containerName}' belongs to another bundle `
      + `(expected label ${BUNDLE_ROOT_LABEL}=${settings.bundleRoot}, found ${identity.bundleRoot ?? "<unlabeled>"})`,
    );
  }
  return identity.status;
}

async function inspectContainerIdentity(containerName: string): Promise<ContainerIdentity | undefined> {
  const format = `{{json .State.Status}}\n{{json (index .Config.Labels "${BUNDLE_ROOT_LABEL}")}}`;
  const result = await executeChild(
    "docker",
    ["inspect", "--type", "container", "--format", format, containerName],
    { stdio: "pipe", forwardSignals: false },
  );
  if (result.exitCode === 0) {
    const [rawStatus, rawBundleRoot] = result.stdout.trim().split(/\r?\n/, 2);
    let status: unknown;
    let bundleRoot: unknown;
    try {
      status = JSON.parse(rawStatus ?? "");
      bundleRoot = JSON.parse(rawBundleRoot ?? "null");
    } catch {
      throw new Error(`docker inspect returned an invalid identity for service container '${containerName}'`);
    }
    if (typeof status !== "string" || !status) {
      throw new Error(`docker inspect returned no status for service container '${containerName}'`);
    }
    return {
      status,
      ...(typeof bundleRoot === "string" && bundleRoot ? { bundleRoot } : {}),
    };
  }
  if (/no such (?:object|container)/i.test(result.stderr)) return undefined;
  throw new Error(result.stderr.trim() || `docker inspect failed with exit code ${result.exitCode}`);
}
async function inspectPublishedPort(
  container: string,
  containerPort: number,
): Promise<number | undefined> {
  try {
    const result = await executeChild(
      "docker",
      ["port", container, `${containerPort}/tcp`],
      { stdio: "pipe", forwardSignals: false },
    );
    if (result.exitCode !== 0) return undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.trim().match(/:(\d+)$/);
      if (!match) continue;
      const port = Number(match[1]);
      if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) return port;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function printPortSelection(
  context: CommandContext,
  configured: RunSettings,
  selected: RunSettings,
): void {
  if (selected.adapterPort !== configured.adapterPort) {
    context.io.stdout.write(`Adapter port ${configured.adapterPort} is busy; using ${selected.adapterPort}.\n`);
  }
  if (selected.corePort !== configured.corePort) {
    context.io.stdout.write(`Core port ${configured.corePort} is busy; using ${selected.corePort}.\n`);
  }
}


function printAgentEndpoints(
  context: CommandContext,
  result: CheckResult,
  settings: RunSettings,
  adapterPort = settings.adapterPort,
  pending = false,
): void {
  const directoryFlag = resolve(context.cwd) === result.project.rootDir
    ? ""
    : ` --dir ${shellQuote(result.project.rootDir)}`;
  const base = `http://localhost:${adapterPort}/v1/agents/${result.agent.id}`;
  const label = pending
    ? "Agent endpoint if Docker starts"
    : "Agent endpoint (available once listening; not a readiness check)";
  context.io.stdout.write(`${label}: ${base}\n`);
  context.io.stdout.write(`TUI: omp-bundler tui${directoryFlag}\n`);
}

function isSafeImageTag(tag: string): boolean {
  return SAFE_IMAGE_TAG.test(tag) && !tag.includes("..");
}

function writeValidationErrors(
  context: CommandContext,
  result: CheckResult,
): void {
  context.io.stderr.write(`omp-bundler run found ${result.errors.length} validation error(s):\n`);
  for (const error of result.errors) context.io.stderr.write(`Error: ${formatIssue(error)}\n`);
}

function usageError(context: CommandContext, message: string): number {
  context.io.stderr.write(`omp-bundler run: ${message}\nUsage: ${RUN_HELP.split("\n", 1)[0]}\n`);
  return 1;
}
