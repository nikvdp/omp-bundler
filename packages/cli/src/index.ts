export { main, CLI_NAME, CLI_VERSION, ROOT_HELP } from "./cli.ts";
export { ArgumentError, parseArgs, optionBoolean, optionString } from "./args.ts";
export { resolvePackagedAsset, requirePackagedAsset } from "./assets.ts";
export { parseYaml, readYamlFile, stringifyYaml, writeYamlFile, YamlError } from "./config.ts";
export {
  applyFilePlan,
  createDirectoryPlan,
  createFilePlan,
  createMovePlan,
  createRemovePlan,
  describeFilePlan,
} from "./file-plan.ts";
export {
  COMMAND_HELP,
  PendingCommandError,
  ROOT_COMMANDS,
  ROOT_HANDLERS,
  commandArgs,
  handlerContext,
  invokeHandler,
  pendingCommandHandler,
  routeCommand,
} from "./handlers.ts";
export type { RootCommandHandlerMap } from "./handlers.ts";
export { assertSafeIdentifier, assertSafeRelativePath, isSafeIdentifier, resolveInside, SAFE_IDENTIFIER_PATTERN } from "./identifiers.ts";
export { executeChild } from "./process.ts";
export { discoverAgents, loadProject, resolveAgentPath, resolveBundleRoot, resolveCommandPath, PROJECT_CONFIG_FILE } from "./project.ts";
export { agentCommand } from "./commands/agent.ts";
export { destroyCommand } from "./commands/destroy.ts";
export type {
  AgentDirectory,
  CliIO,
  CommandContext,
  CommandHandler,
  CommandHandlerRegistry,
  FileOperation,
  FilePlan,
  ParsedArguments,
  PlannedWrite,
  ProcessResult,
  ProjectConfig,
  ProjectContext,
  Scalar,
  YamlValue,
} from "./types.ts";
export type { ApplyFilePlanOptions, FilePlanOptions } from "./file-plan.ts";
export type { ExecuteOptions } from "./process.ts";
export type { OptionSpec, OptionType } from "./args.ts";
