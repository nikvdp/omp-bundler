import type { Readable, Writable } from "node:stream";

export type Scalar = string | number | boolean | null;
export type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };

export interface ParsedArguments {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
}

export interface CliIO {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface CommandContext {
  readonly cwd: string;
  readonly io: CliIO;
}

export type CommandHandler = (
  args: ParsedArguments,
  context: CommandContext,
) => Promise<number | void> | number | void;

/** One explicit registry filled by the command-slice implementations. */
export interface CommandHandlerRegistry {
  readonly new?: CommandHandler;
  readonly generate?: CommandHandler;
  readonly destroy?: CommandHandler;
  readonly check?: CommandHandler;
  readonly build?: CommandHandler;
  readonly run?: CommandHandler;
  readonly status?: CommandHandler;
  readonly stop?: CommandHandler;
  readonly restart?: CommandHandler;
  readonly logs?: CommandHandler;
  readonly tui?: CommandHandler;
  readonly model?: CommandHandler;
}

export interface ProjectConfig {
  readonly version: number;
  readonly agent: {
    readonly id: string;
    readonly [key: string]: YamlValue | undefined;
  };
  readonly image?: {
    readonly tag?: string;
    readonly [key: string]: YamlValue | undefined;
  };
  readonly run?: {
    readonly dataVolume?: string;
    readonly corePort?: number;
    readonly adapterPort?: number;
    readonly [key: string]: YamlValue | undefined;
  };
}

export interface ProjectContext {
  readonly rootDir: string;
  readonly configPath: string;
  readonly config: ProjectConfig;
  readonly agent: AgentDirectory;
}

export interface AgentDirectory {
  readonly id: string;
  /** Complete visible agent source root. */
  readonly path: string;
}

export interface PlannedWrite {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly overwrite?: boolean;
  readonly mode?: number;
}

export type FileOperation =
  | { readonly kind: "write"; readonly path: string; readonly content: string | Uint8Array; readonly overwrite: boolean; readonly mode?: number }
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "move"; readonly from: string; readonly to: string }
  | { readonly kind: "remove"; readonly path: string };

export interface FilePlan {
  readonly root: string;
  readonly operations: readonly FileOperation[];
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
