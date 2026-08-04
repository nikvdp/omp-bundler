import type {
  CliIO,
  CommandContext,
  CommandHandler,
  CommandHandlerRegistry,
  ParsedArguments,
} from "./types.ts";
import {
  buildCommand,
  checkCommand,
  destroyCommand,
  generateCommand,
  newCommand,
  runCommand,
  serviceCommand,
  SERVICE_HELP,
  setModelCommand,
  tuiCommand,
  TUI_HELP,
  SET_MODEL_HELP,
} from "./commands/index.ts";

export { type CliIO, type CommandContext, type CommandHandler, type CommandHandlerRegistry } from "./types.ts";

export const ROOT_COMMANDS = [
  "new",
  "generate",
  "destroy",
  "set-model",
  "check",
  "build",
  "run",
  "service",
  "tui",
] as const;

export type RootCommand = (typeof ROOT_COMMANDS)[number];

export const COMMAND_HELP: Record<RootCommand, string> = {
  new: "omp-bundler new <path> [--id <agent-id>]",
  generate: [
    "omp-bundler generate skill <name> [--dry-run]",
    "omp-bundler generate command <name> [--dry-run]",
    "omp-bundler generate tool <name> [--dry-run]",
    "omp-bundler generate extension <name> [--dry-run]",
    "omp-bundler generate subagent <name> [--dry-run]",
    "omp-bundler generate adapter pumble [--dry-run]",
  ].join("\n"),
  destroy: [
    "omp-bundler destroy skill <name> [--dry-run] [--yes]",
    "omp-bundler destroy command <name> [--dry-run] [--yes]",
    "omp-bundler destroy tool <name> [--dry-run] [--yes]",
    "omp-bundler destroy extension <name> [--dry-run] [--yes]",
    "omp-bundler destroy subagent <name> [--dry-run] [--yes]",
  ].join("\n"),
  "set-model": SET_MODEL_HELP,
  check: "omp-bundler check [bundle-path] [--env-file <path>]",
  build: "omp-bundler build [bundle-path] [--tag <image-tag>]",
  run: "omp-bundler run [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]",
  service: SERVICE_HELP,
  tui: TUI_HELP,
};

export type RootCommandHandlerMap = {
  readonly [Command in RootCommand]: CommandHandler;
};

export const ROOT_HANDLERS: RootCommandHandlerMap = {
  new: newCommand,
  generate: generateCommand,
  destroy: destroyCommand,
  "set-model": setModelCommand,
  check: checkCommand,
  build: buildCommand,
  run: runCommand,
  service: serviceCommand,
  tui: tuiCommand,
};

export function commandArgs(
  positionals: readonly string[],
  options: Record<string, string | boolean>,
): ParsedArguments {
  return { positionals: [...positionals], options: { ...options } };
}

export function routeCommand(command: string): RootCommand | undefined {
  return (ROOT_COMMANDS as readonly string[]).includes(command)
    ? (command as RootCommand)
    : undefined;
}

export function invokeHandler(
  handler: CommandHandler,
  args: ParsedArguments,
  context: CommandContext,
): Promise<number | void> {
  return Promise.resolve(handler(args, context));
}

export function handlerContext(cwd: string, io: CliIO): CommandContext {
  return { cwd, io };
}
