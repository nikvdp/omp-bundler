import { basename } from "node:path";
import { executeChild } from "../process.ts";
import { validateBundle, formatIssue } from "./check.ts";
import {
  assertAllowedOptions,
  requiredOptionString,
} from "./common.ts";
import {
  buildDockerArgs,
  formatDockerCommand,
  removeDockerContext,
  stageDockerContext,
} from "./docker.ts";
import type { CheckResult } from "./check.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";

export const BUILD_HELP = `omp-bundler build [bundle-path] [--tag <image-tag>] [--agents <path>]

Validate the bundle without runtime configuration, stage the packaged runtime,
and build its Docker image.`;

const SAFE_IMAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export const buildCommand: CommandHandler = async (
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> => {
  if (args.options.help === true) {
    context.io.stdout.write(`${BUILD_HELP}\n`);
    return 0;
  }
  if (args.options.help !== undefined) {
    return usageError(context, "--help does not accept a value");
  }

  try {
    assertAllowedOptions(args, ["tag", "agents"]);
  } catch (error) {
    return usageError(context, error instanceof Error ? error.message : String(error));
  }
  if (args.positionals.length > 1) {
    return usageError(context, "accepts at most one bundle path");
  }

  const tagOption = args.options.tag;
  const agentsOption = args.options.agents;
  let tagOverride: string | undefined;
  let agentsOverride: string | undefined;
  try {
    if (tagOption !== undefined) tagOverride = requiredOptionString(args, "tag");
    if (agentsOption !== undefined) agentsOverride = requiredOptionString(args, "agents");
  } catch (error) {
    return usageError(context, error instanceof Error ? error.message : String(error));
  }
  if (tagOverride !== undefined && !isSafeImageTag(tagOverride)) {
    return usageError(context, "--tag must be a safe Docker image tag");
  }

  const result = await validateBundle({
    cwd: context.cwd,
    ...(args.positionals[0] === undefined ? {} : { bundlePath: args.positionals[0] }),
    ...(agentsOverride === undefined ? {} : { agentsDirOverride: agentsOverride }),
  });
  if (!result.ok) {
    writeValidationErrors(context, "build", result);
    return 1;
  }

  const tag = resolveBuildTag(result, tagOverride);
  if (!isSafeImageTag(tag)) {
    return usageError(context, `image tag is not safe for Docker: ${tag}`);
  }

  let contextPath: string | undefined;
  try {
    contextPath = await stageDockerContext(result.agents);
    const docker = await executeChild("docker", buildDockerArgs(tag, contextPath), {
      stdio: "inherit",
      forwardSignals: true,
    });
    if (docker.exitCode !== 0) {
      context.io.stderr.write(`omp-bundler build: docker build exited with code ${docker.exitCode}\n`);
      return docker.exitCode;
    }
  } finally {
    if (contextPath !== undefined) await removeDockerContext(contextPath);
  }

  context.io.stdout.write(`Built image: ${tag}\n`);
  context.io.stdout.write(
    `Included agents: ${result.agents.length > 0 ? result.agents.map((agent) => agent.id).sort((left, right) => left.localeCompare(right)).join(", ") : "(none)"}\n`,
  );
  return 0;
};

export function resolveBuildTag(
  result: Pick<CheckResult, "project">,
  override?: string,
): string {
  if (override !== undefined) return override;
  const configured = result.project.config.image?.tag;
  if (typeof configured === "string" && configured.trim()) return configured;
  return `${basename(result.project.rootDir)}:local`;
}

export function buildPreviewCommand(tag: string, contextPath: string): string {
  return formatDockerCommand("docker", buildDockerArgs(tag, contextPath));
}

function isSafeImageTag(tag: string): boolean {
  return SAFE_IMAGE_TAG.test(tag) && !tag.includes("..");
}

function writeValidationErrors(
  context: CommandContext,
  command: string,
  result: CheckResult,
): void {
  context.io.stderr.write(`omp-bundler ${command} found ${result.errors.length} validation error(s):\n`);
  for (const error of result.errors) context.io.stderr.write(`Error: ${formatIssue(error)}\n`);
}

function usageError(context: CommandContext, message: string): number {
  context.io.stderr.write(`omp-bundler build: ${message}\nUsage: ${BUILD_HELP.split("\n", 1)[0]}\n`);
  return 1;
}
