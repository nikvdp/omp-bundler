import { optionBoolean, optionString } from "../args.ts";
import { executeChild } from "../process.ts";
import { loadProject } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";
import { assertAllowedOptions } from "./common.ts";
import {
  discoverPublishedAdapterPort,
  inspectBundleServiceContainer,
  resolveRunSettings,
} from "./run.ts";

export const STATUS_HELP = "omp-bundler status [bundle-path]";
export const STOP_HELP = "omp-bundler stop [bundle-path]";
export const RESTART_HELP = "omp-bundler restart [bundle-path]";
export const LOGS_HELP = "omp-bundler logs [bundle-path] [--follow] [--tail <lines>]";

export const statusCommand: CommandHandler = async (args, context) => {
  if (writeHelp(args, context, STATUS_HELP)) return 0;
  const { project, settings, state } = await resolveLifecycle(args, context, []);
  context.io.stdout.write(`Service: ${state ?? "stopped"}\n`);
  context.io.stdout.write(`Container: ${settings.containerName}\n`);
  context.io.stdout.write(`Agent: ${project.agent.id}\n`);
  if (state === "running") {
    const port = await discoverPublishedAdapterPort(project.rootDir, settings.containerName);
    if (port !== undefined) {
      context.io.stdout.write(`Endpoint: http://localhost:${port}/v1/agents/${project.agent.id}\n`);
    }
  }
  return state === undefined ? 1 : 0;
};

export const stopCommand: CommandHandler = async (args, context) => {
  if (writeHelp(args, context, STOP_HELP)) return 0;
  const { settings, state } = await resolveLifecycle(args, context, []);
  if (state === undefined) {
    context.io.stdout.write(`Service ${settings.containerName}: stopped\n`);
    return 0;
  }
  return dockerLifecycle("stop", settings.containerName, context);
};

export const restartCommand: CommandHandler = async (args, context) => {
  if (writeHelp(args, context, RESTART_HELP)) return 0;
  const { settings, state } = await resolveLifecycle(args, context, []);
  if (state === undefined) {
    context.io.stderr.write(`Service ${settings.containerName} does not exist; run 'omp-bundler run'.\n`);
    return 1;
  }
  return dockerLifecycle("restart", settings.containerName, context);
};

export const logsCommand: CommandHandler = async (args, context) => {
  if (writeHelp(args, context, LOGS_HELP)) return 0;
  const { settings, state } = await resolveLifecycle(args, context, ["follow", "tail"]);
  if (state === undefined) {
    context.io.stderr.write(`Service ${settings.containerName} does not exist; run 'omp-bundler run'.\n`);
    return 1;
  }
  if (args.options.follow !== undefined && !optionBoolean(args, "follow")) {
    throw new Error("--follow does not accept a value");
  }
  const tail = optionString(args, "tail") ?? "100";
  if (tail !== "all" && (!/^\d+$/.test(tail) || !Number.isSafeInteger(Number(tail)))) {
    throw new Error("--tail must be a non-negative integer or 'all'");
  }
  const result = await executeChild(
    "docker",
    ["logs", "--tail", tail, ...(optionBoolean(args, "follow") ? ["--follow"] : []), settings.containerName],
    { stdio: "inherit", forwardSignals: optionBoolean(args, "follow") },
  );
  return result.exitCode;
};

async function resolveLifecycle(
  args: ParsedArguments,
  context: CommandContext,
  allowedOptions: readonly string[],
) {
  assertAllowedOptions(args, allowedOptions);
  if (args.positionals.length > 1) throw new Error("accepts at most one bundle path");
  const project = await loadProject(args.positionals[0], context.cwd);
  const settings = resolveRunSettings({ project });
  const state = await inspectBundleServiceContainer(settings);
  return { project, settings, state };
}

async function dockerLifecycle(
  action: "stop" | "restart",
  containerName: string,
  context: CommandContext,
): Promise<number> {
  const result = await executeChild("docker", [action, containerName], {
    stdio: "pipe",
    forwardSignals: false,
  });
  if (result.exitCode !== 0) {
    context.io.stderr.write(result.stderr || `docker ${action} failed with exit code ${result.exitCode}\n`);
    return result.exitCode;
  }
  context.io.stdout.write(`Service ${containerName}: ${action === "stop" ? "stopped" : "restarted"}\n`);
  return 0;
}

function writeHelp(args: ParsedArguments, context: CommandContext, help: string): boolean {
  if (args.options.help !== true) return false;
  context.io.stdout.write(`${help}\n`);
  return true;
}
