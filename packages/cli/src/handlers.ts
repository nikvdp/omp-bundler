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
  logsCommand,
  LOGS_HELP,
  restartCommand,
  RESTART_HELP,
  startCommand,
  START_HELP,
  statusCommand,
  STATUS_HELP,
  stopCommand,
  STOP_HELP,
  modelCommand,
  tuiCommand,
  TUI_HELP,
  MODEL_HELP,
} from "./commands/index.ts";

export { type CliIO, type CommandContext, type CommandHandler, type CommandHandlerRegistry } from "./types.ts";

export const ROOT_COMMANDS = [
  "new",
  "generate",
  "destroy",
  "model",
  "check",
  "build",
  "run",
  "start",
  "status",
  "stop",
  "restart",
  "logs",
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
  model: MODEL_HELP,
  check: "omp-bundler check [bundle-path] [--env-file <path>]",
  build: "omp-bundler build [bundle-path] [--tag <image-tag>]",
  run: "omp-bundler run [bundle-path] [--foreground] [--env-file <path>] [--image <tag>] [--dry-run]",
  start: START_HELP,
  status: STATUS_HELP,
  stop: STOP_HELP,
  restart: RESTART_HELP,
  logs: LOGS_HELP,
  tui: TUI_HELP,
};

export type RootCommandHandlerMap = {
  readonly [Command in RootCommand]: CommandHandler;
};

export const ROOT_HANDLERS: RootCommandHandlerMap = {
  new: newCommand,
  generate: generateCommand,
  destroy: destroyCommand,
  model: modelCommand,
  check: checkCommand,
  build: buildCommand,
  run: runCommand,
  start: startCommand,
  status: statusCommand,
  stop: stopCommand,
  restart: restartCommand,
  logs: logsCommand,
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
