#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yargs, { type ArgumentsCamelCase, type Argv } from "yargs";
import {
  ROOT_COMMANDS,
  ROOT_HANDLERS,
  commandArgs,
  handlerContext,
  type RootCommand,
} from "./handlers.ts";
import type { CliIO, CommandHandlerRegistry, CommandContext } from "./types.ts";

export const CLI_NAME = "omp-bundler";
export const CLI_VERSION = "0.1.0";

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
  let exitCode = 0;
  const dispatch = async (
    command: RootCommand,
    positionals: readonly string[],
    parsed: ArgumentsCamelCase,
    optionNames: readonly string[],
  ): Promise<void> => {
    const handler = context.handlers?.[command] ?? ROOT_HANDLERS[command];
    if (!handler) throw new Error(`command '${command}' is not available`);
    const options: Record<string, string | boolean> = {};
    for (const name of optionNames) {
      const value = parsed[name];
      if (typeof value === "string" || typeof value === "boolean") options[name] = value;
      else if (typeof value === "number") options[name] = String(value);
    }
    exitCode = (await handler(commandArgs(positionals, options), handlerContext(context.cwd, context.io))) ?? 0;
  };

  const parser = createParser(dispatch, context.io);
  if (argv.length === 0) {
    context.io.stdout.write(`${await parser.getHelp()}\n`);
    return 0;
  }

  let parseError: Error | undefined;
  let parserOutput = "";
  try {
    await parser.parseAsync([...argv], {}, (error, _parsed, output) => {
      parseError = error ?? undefined;
      parserOutput = output;
    });
  } catch (error) {
    parseError ??= error instanceof Error ? error : new Error(String(error));
  }

  if (parserOutput) {
    const stream = parseError ? context.io.stderr : context.io.stdout;
    stream.write(parserOutput.endsWith("\n") ? parserOutput : `${parserOutput}\n`);
  }
  if (parseError) {
    if (!parserOutput) context.io.stderr.write(`Error: ${parseError.message}\n`);
    return 1;
  }
  return exitCode;
}

function createParser(
  dispatch: (
    command: RootCommand,
    positionals: readonly string[],
    parsed: ArgumentsCamelCase,
    optionNames: readonly string[],
  ) => Promise<void>,
  io: CliIO,
): Argv {
  const parser = yargs()
    .scriptName(CLI_NAME)
    .usage("$0 <command> [options]")
    .epilogue("Run 'omp-bundler <command> --help' for command-specific help.")
    .parserConfiguration({ "camel-case-expansion": false })
    .strictCommands()
    .strictOptions()
    .recommendCommands()
    .showHelpOnFail(false)
    .exitProcess(false)
    .help("help")
    .alias("help", "h")
    .version("version", "Show the installed version", CLI_VERSION)
    .alias("version", "v")
    .completion("completion-script", false);

  parser.command(
    "new <path>",
    "Create a complete single-agent bundle",
    (command) => command
      .positional("path", { type: "string", describe: "Bundle directory" })
      .option("id", { type: "string", describe: "Agent ID; defaults to the directory name" })
      .option("dry-run", { type: "boolean", describe: "Print changes without writing files" }),
    (args) => dispatch("new", [args.path as string], args, ["id", "dry-run"]),
  );

  parser.command(
    "generate <kind> <name>",
    "Generate an agent component or adapter configuration",
    (command) => command
      .positional("kind", {
        choices: ["skill", "command", "tool", "extension", "subagent", "adapter"] as const,
        describe: "Component type",
      })
      .positional("name", { type: "string", describe: "Component name or adapter type" })
      .option("dry-run", { type: "boolean", describe: "Print changes without writing files" }),
    (args) => dispatch("generate", [String(args.kind), args.name as string], args, ["dry-run"]),
  );

  parser.command(
    "destroy <kind> <name>",
    "Remove a generated component",
    (command) => command
      .positional("kind", {
        choices: ["skill", "command", "tool", "extension", "subagent"] as const,
        describe: "Component type",
      })
      .positional("name", { type: "string", describe: "Component name" })
      .option("dry-run", { type: "boolean", describe: "Print changes without deleting files" })
      .option("yes", { type: "boolean", describe: "Skip the confirmation prompt" }),
    (args) => dispatch("destroy", [String(args.kind), args.name as string], args, ["dry-run", "yes"]),
  );

  parser.command(
    "model <action> [selector]",
    "Add, select, or list models in the native OMP catalog",
    (command) => command
      .positional("action", {
        choices: ["add", "set-default", "list"] as const,
        describe: "Catalog operation",
      })
      .positional("selector", { type: "string", describe: "Provider/model selector" })
      .option("from", { choices: ["omp"] as const, describe: "Import provider metadata from installed OMP" })
      .option("base-url", { type: "string", describe: "Provider API base URL" })
      .option("api", {
        choices: ["openai-responses", "openai-completions", "anthropic-messages"] as const,
        describe: "Provider protocol dialect",
      })
      .option("api-key-env", { type: "string", describe: "Provider credential environment variable" })
      .option("no-auth", { type: "boolean", describe: "Configure a provider that requires no API key" }),
    (args) => dispatch(
      "model",
      [String(args.action), ...(args.selector === undefined ? [] : [String(args.selector)])],
      args,
      ["from", "base-url", "api", "api-key-env", "no-auth"],
    ),
  );

  addBundleCommand(parser, "check", "Validate bundle source and runtime bindings", dispatch, [
    ["env-file", { type: "string", describe: "Runtime environment file" }],
  ]);
  addBundleCommand(parser, "build", "Build the bundle's container image", dispatch, [
    ["tag", { type: "string", describe: "Container image tag" }],
  ]);
  addBundleCommand(parser, "run", "Start the bundle as a background service", dispatch, [
    ["foreground", { type: "boolean", describe: "Own the terminal instead of starting in the background" }],
    ["env-file", { type: "string", describe: "Runtime environment file" }],
    ["image", { type: "string", describe: "Container image tag" }],
    ["dry-run", { type: "boolean", describe: "Print the Docker command without running it" }],
  ]);
  addBundleCommand(parser, "status", "Show owned service state and endpoint", dispatch, []);
  addBundleCommand(parser, "stop", "Stop the owned service", dispatch, []);
  addBundleCommand(parser, "restart", "Restart the owned service", dispatch, []);
  addBundleCommand(parser, "logs", "Show logs from the owned service", dispatch, [
    ["follow", { type: "boolean", alias: "f", describe: "Continue following new log output" }],
    ["tail", { type: "string", alias: "n", default: "100", describe: "Lines to show from the end, or 'all'" }],
  ]);
  parser.command(
    "tui",
    "Chat with the live bundle in the terminal",
    (command) => command
      .option("dir", { type: "string", describe: "Bundle directory; defaults to the current directory" })
      .option("endpoint", { type: "string", describe: "Exact agent URL, bypassing bundle discovery" }),
    (args) => dispatch("tui", [], args, ["dir", "endpoint"]),
  );

  parser.command(
    "completion <shell>",
    "Print a shell completion script",
    (command) => command.positional("shell", {
      choices: ["bash", "zsh", "fish"] as const,
      describe: "Target shell",
    }),
    (args) => {
      io.stdout.write(completionScript(String(args.shell)));
    },
  );

  return parser;
}

type OptionDefinition = readonly [
  name: string,
  config: {
    readonly type: "string" | "boolean";
    readonly alias?: string;
    readonly default?: string;
    readonly describe: string;
  },
];

function addBundleCommand(
  parser: Argv,
  commandName: RootCommand,
  description: string,
  dispatch: (
    command: RootCommand,
    positionals: readonly string[],
    parsed: ArgumentsCamelCase,
    optionNames: readonly string[],
  ) => Promise<void>,
  definitions: readonly OptionDefinition[],
): void {
  parser.command(
    `${commandName} [bundle-path]`,
    description,
    (command) => {
      let builder = command.positional("bundle-path", { type: "string", describe: "Bundle directory" });
      for (const [name, config] of definitions) builder = builder.option(name, config);
      return builder;
    },
    (args) => dispatch(
      commandName,
      args["bundle-path"] === undefined ? [] : [String(args["bundle-path"])],
      args,
      definitions.map(([name]) => name),
    ),
  );
}

function completionScript(shell: string): string {
  if (shell === "bash") {
    return `# bash completion for omp-bundler\n_omp_bundler_completions() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  mapfile -t COMPREPLY < <(compgen -W "$(env SHELL=/bin/bash omp-bundler --get-yargs-completions "\${COMP_WORDS[@]}")" -- "$cur")\n}\ncomplete -o bashdefault -o default -F _omp_bundler_completions omp-bundler\n`;
  }
  if (shell === "zsh") {
    return `#compdef omp-bundler\n_omp_bundler_completions() {\n  local -a completions\n  completions=("\${(@f)$(env SHELL=/bin/zsh omp-bundler --get-yargs-completions "\${words[@]}")}")\n  _describe 'omp-bundler commands and options' completions\n}\ncompdef _omp_bundler_completions omp-bundler\n`;
  }
  return `function __omp_bundler_completions\n  env SHELL=/bin/bash omp-bundler --get-yargs-completions (commandline -opc)\nend\ncomplete -c omp-bundler -f -a '(__omp_bundler_completions)'\n`;
}

function isInvokedAsCli(): boolean {
  if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) return true;
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedAsCli()) {
  process.exitCode = await main();
}

export { ROOT_COMMANDS, ROOT_HANDLERS };
export type { CliIO, CommandContext, CommandHandlerRegistry } from "./types.ts";
