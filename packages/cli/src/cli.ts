#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArgumentError, parseArgs } from "./args.ts";
import {
  COMMAND_HELP,
  PendingCommandError,
  ROOT_COMMANDS,
  ROOT_HANDLERS,
  commandArgs,
  handlerContext,
  invokeHandler,
  routeCommand,
} from "./handlers.ts";
import type {
  CliIO,
  CommandHandlerRegistry,
  CommandContext,
} from "./types.ts";

export const CLI_NAME = "omp-bundler";
export const CLI_VERSION = "0.1.0";

export const ROOT_HELP = `${CLI_NAME} - Build and run filesystem-configured OMP agents as a durable service.

Usage:
  ${CLI_NAME} <command> [arguments] [options]

Commands:
  ${COMMAND_HELP.new}

  ${COMMAND_HELP.generate.replaceAll("\n", "\n  ")}

  ${COMMAND_HELP.destroy.replaceAll("\n", "\n  ")}

  ${COMMAND_HELP.agent.replaceAll("\n", "\n  ")}

  ${COMMAND_HELP.check}
  ${COMMAND_HELP.build}
  ${COMMAND_HELP.run}

Options:
  -h, --help       Show help for a command
  -v, --version    Show the installed version`;

const DEFAULT_IO: CliIO = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

export interface MainContext extends CommandContext {
  readonly handlers?: CommandHandlerRegistry;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  context: MainContext = {
    cwd: process.cwd(),
    io: DEFAULT_IO,
  },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return reportError(context.io, error instanceof Error ? error.message : String(error));
  }

  if (parsed.options.version === true) {
    writeLine(context.io.stdout, CLI_VERSION);
    return 0;
  }
  if (parsed.options.help === true && parsed.positionals.length === 0) {
    writeLine(context.io.stdout, ROOT_HELP);
    return 0;
  }

  const commandName = parsed.positionals[0];
  if (commandName === undefined) {
    writeLine(context.io.stdout, ROOT_HELP);
    return 0;
  }
  const command = routeCommand(commandName);
  if (!command) {
    return reportError(
      context.io,
      `unknown command '${commandName}'. Run '${CLI_NAME} --help' for available commands`,
    );
  }
  if (parsed.options.help === true) {
    writeLine(context.io.stdout, COMMAND_HELP[command]);
    return 0;
  }

  const handler = context.handlers?.[command] ?? ROOT_HANDLERS[command];

  const args = commandArgs(parsed.positionals.slice(1), parsed.options);
  try {
    const result = await invokeHandler(handler, args, handlerContext(context.cwd, context.io));
    return typeof result === "number" ? result : 0;
  } catch (error) {
    if (error instanceof PendingCommandError) return reportError(context.io, error.message);
    return reportError(context.io, error instanceof Error ? error.message : String(error));
  }
}

function writeLine(stream: CliIO["stdout"] | CliIO["stderr"], text: string): void {
  stream.write(`${text}\n`);
}

function reportError(io: CliIO, message: string): number {
  writeLine(io.stderr, `${CLI_NAME}: ${message}`);
  return 1;
}

function isInvokedAsCli(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedAsCli()) {
  main().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  }).catch((error: unknown) => {
    reportError(DEFAULT_IO, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { ROOT_COMMANDS, ROOT_HANDLERS };
export type { CliIO, CommandContext, CommandHandlerRegistry } from "./types.ts";
