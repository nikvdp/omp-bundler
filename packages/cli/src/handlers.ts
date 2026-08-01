import type {
  CliIO,
  CommandContext,
  CommandHandler,
  CommandHandlerRegistry,
  ParsedArguments,
} from "./types.ts";

export { type CliIO, type CommandContext, type CommandHandler, type CommandHandlerRegistry } from "./types.ts";

export class PendingCommandError extends Error {
  constructor(command: string) {
    super(`the '${command}' command is not integrated yet`);
    this.name = "PendingCommandError";
  }
}

export const ROOT_COMMANDS = [
  "new",
  "generate",
  "destroy",
  "agent",
  "check",
  "build",
  "run",
] as const;

export type RootCommand = (typeof ROOT_COMMANDS)[number];

export const COMMAND_HELP: Record<RootCommand, string> = {
  new: "omp-bundler new <path> [--agent <agent-id>]",
  generate: [
    "omp-bundler generate agent <agent-id> [--dry-run]",
    "omp-bundler generate skill <agent-id> <name> [--dry-run]",
    "omp-bundler generate command <agent-id> <name> [--dry-run]",
    "omp-bundler generate tool <agent-id> <name> [--dry-run]",
    "omp-bundler generate extension <agent-id> <name> [--dry-run]",
    "omp-bundler generate subagent <agent-id> <name> [--dry-run]",
    "omp-bundler generate adapter <adapter-type> --agent <agent-id> [--dry-run]",
  ].join("\n"),
  destroy: [
    "omp-bundler destroy agent <agent-id> [--dry-run] [--yes]",
    "omp-bundler destroy skill <agent-id> <name> [--dry-run] [--yes]",
    "omp-bundler destroy command <agent-id> <name> [--dry-run] [--yes]",
    "omp-bundler destroy tool <agent-id> <name> [--dry-run] [--yes]",
    "omp-bundler destroy extension <agent-id> <name> [--dry-run] [--yes]",
    "omp-bundler destroy subagent <agent-id> <name> [--dry-run] [--yes]",
  ].join("\n"),
  agent: [
    "omp-bundler agent model <agent-id> <provider/model>",
    "omp-bundler agent rename <old-agent-id> <new-agent-id>",
  ].join("\n"),
  check: "omp-bundler check [bundle-path] [--env-file <path>]",
  build: "omp-bundler build [bundle-path] [--tag <image-tag>] [--agents <path>]",
  run: "omp-bundler run [bundle-path] --env-file <path> [--image <tag>] [--dry-run]",
};

export function pendingCommandHandler(command: string): CommandHandler {
  return () => {
    throw new PendingCommandError(command);
  };
}
export type RootCommandHandlerMap = {
  readonly [Command in RootCommand]: CommandHandler;
};

/** Every root command has an explicit handler until its command slice replaces it. */
export const ROOT_HANDLERS: RootCommandHandlerMap = {
  new: pendingCommandHandler("new"),
  generate: pendingCommandHandler("generate"),
  destroy: pendingCommandHandler("destroy"),
  agent: pendingCommandHandler("agent"),
  check: pendingCommandHandler("check"),
  build: pendingCommandHandler("build"),
  run: pendingCommandHandler("run"),
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
