import { basename, join } from "node:path";
import { optionBoolean } from "../args.ts";
import { executeChild } from "../process.ts";
import { resolveBundleRoot, resolveDefaultEnvFile } from "../project.ts";
import { validateBundle, formatIssue } from "./check.ts";
import { assertAllowedOptions, requiredOptionString } from "./common.ts";
import {
  formatDockerCommand,
  runDockerArgs,
} from "./docker.ts";
import type { CheckResult } from "./check.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";

export const RUN_HELP = `omp-bundler run [bundle-path] [--env-file <path>] [--image <tag>] [--agents <path>] [--dry-run]

Validate runtime bindings, then run the configured image with its ports and
named data volume. --env-file defaults to the bundle's runtime.env; copy
runtime.env.example to runtime.env to fill deployment values. --agents
selects the agent collection used to validate adapter bindings without
changing the image. --dry-run prints the Docker command without executing it.`;

const SAFE_IMAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface RunSettings {
  readonly image: string;
  readonly corePort: number;
  readonly adapterPort: number;
  readonly dataVolume: string;
}

export const runCommand: CommandHandler = async (
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> => {
  if (args.options.help === true) {
    context.io.stdout.write(`${RUN_HELP}\n`);
    return 0;
  }
  if (args.options.help !== undefined) {
    return usageError(context, "--help does not accept a value");
  }

  try {
    assertAllowedOptions(args, ["env-file", "image", "agents", "dry-run"]);
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

  let agentsOverride: string | undefined;
  if (args.options.agents !== undefined) {
    try {
      agentsOverride = requiredOptionString(args, "agents");
    } catch (error) {
      return usageError(context, error instanceof Error ? error.message : String(error));
    }
  }

  const result = await validateBundle({
    cwd: context.cwd,
    ...(args.positionals[0] === undefined ? {} : { bundlePath: args.positionals[0] }),
    envFile,
    ...(agentsOverride === undefined ? {} : { agentsDirOverride: agentsOverride }),
  });
  if (!result.ok) {
    writeValidationErrors(context, result);
    return 1;
  }
  if (result.envFile === undefined) {
    return usageError(context, "--env-file was not resolved");
  }

  const settings = resolveRunSettings(result, imageOverride);
  const dockerArgs = runDockerArgs({ ...settings, envFile: result.envFile });
  if (optionBoolean(args, "dry-run")) {
    context.io.stdout.write(`${formatDockerCommand("docker", dockerArgs)}\n`);
    return 0;
  }
  for (const agent of result.agents) {
    const base = `http://localhost:${settings.adapterPort}/v1/agents/${agent.id}`;
    context.io.stdout.write(`Agent endpoint (available once listening; not a readiness check): ${base}\n`);
    context.io.stdout.write(`TUI: omp-tui ${base}\n`);
  }

  const docker = await executeChild("docker", dockerArgs, {
    stdio: "inherit",
    forwardSignals: true,
    signalMap: { SIGTERM: "SIGINT" },
  });
  return docker.exitCode;
};

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

  if (!isSafeImageTag(image)) throw new Error(`image tag is not safe for Docker: ${image}`);
  if (!SAFE_VOLUME_NAME.test(dataVolume)) throw new Error(`data volume is not safe for Docker: ${dataVolume}`);
  if (!Number.isSafeInteger(corePort) || corePort < 1 || corePort > 65535) {
    throw new Error(`core port is not valid: ${corePort}`);
  }
  if (!Number.isSafeInteger(adapterPort) || adapterPort < 1 || adapterPort > 65535) {
    throw new Error(`adapter port is not valid: ${adapterPort}`);
  }
  return { image, dataVolume, corePort, adapterPort };
}

export function runPreviewCommand(
  settings: RunSettings,
  envFile: string,
): string {
  return formatDockerCommand("docker", runDockerArgs({ ...settings, envFile }));
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
