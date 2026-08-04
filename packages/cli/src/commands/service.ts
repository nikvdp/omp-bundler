import { executeChild } from "../process.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";
import { assertAllowedOptions } from "./common.ts";
import { inspectBundleServiceContainer, resolveRunSettings, runBundle } from "./run.ts";

export const SERVICE_HELP = [
  "omp-bundler service start [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]",
  "omp-bundler service stop [bundle-path]",
  "omp-bundler service status [bundle-path]",
  "omp-bundler service restart [bundle-path]",
].join("\n");

export const serviceCommand: CommandHandler = async (args, context) => {
  const action = args.positionals[0];
  if (action === undefined) {
    context.io.stdout.write(`${SERVICE_HELP}\n`);
    return 0;
  }
  if (args.options.help === true) {
    context.io.stdout.write(`${serviceActionHelp(action)}\n`);
    return 0;
  }
  if (action === "start") {
    return runBundle(
      { positionals: args.positionals.slice(1), options: args.options },
      context,
      true,
    );
  }
  if (action === "stop" || action === "status" || action === "restart") {
    return serviceLifecycleAction(action, args, context);
  }
  throw new Error(`unknown service action '${action}'. Run 'omp-bundler service --help' for available commands`);
};

async function serviceLifecycleAction(
  action: "stop" | "status" | "restart",
  args: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertAllowedOptions(args, []);
  if (args.positionals.length > 2) {
    throw new Error(`usage: omp-bundler service ${action} [bundle-path]`);
  }
  const project = await loadProject(args.positionals[1], context.cwd);
  const settings = resolveRunSettings({ project });
  const { containerName } = settings;
  const state = await inspectBundleServiceContainer(settings);
  if (state === undefined) {
    if (action === "stop") {
      context.io.stdout.write(`Service ${containerName}: stopped\n`);
      return 0;
    }
    if (action === "status") {
      context.io.stdout.write(`Service ${containerName}: stopped\n`);
      return 1;
    }
    context.io.stderr.write(`Service ${containerName} does not exist; run 'omp-bundler service start'.\n`);
    return 1;
  }
  if (action === "status") {
    context.io.stdout.write(`Service ${containerName}: ${state}\n`);
    return 0;
  }

  const result = await executeChild("docker", [action, containerName], {
    stdio: "pipe",
    forwardSignals: false,
  });
  if (result.exitCode === 0) {
    context.io.stdout.write(`Service ${containerName}: ${action === "stop" ? "stopped" : "restarted"}\n`);
    return 0;
  }
  context.io.stderr.write(result.stderr || `docker ${action} failed with exit code ${result.exitCode}\n`);
  return result.exitCode;
}

function serviceActionHelp(action: string): string {
  const line = SERVICE_HELP.split("\n").find((candidate) => candidate.startsWith(`omp-bundler service ${action} `));
  return line ?? SERVICE_HELP;
}
