import { spawn } from "node:child_process";
import type { SpawnOptions, StdioNull, StdioPipe } from "node:child_process";
import type { ProcessResult } from "./types.ts";

export interface ExecuteOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: SpawnOptions["stdio"];
  readonly input?: string | Uint8Array;
  readonly forwardSignals?: boolean;
  readonly signalMap?: Partial<Record<NodeJS.Signals, NodeJS.Signals>>;
}

export function executeChild(
  command: string,
  args: readonly string[] = [],
  options: ExecuteOptions = {},
): Promise<ProcessResult> {
  const stdio = options.stdio ?? "inherit";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio,
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  if (child.stdout && isReadablePipe(stdio)) child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  if (child.stderr && isReadablePipe(stdio)) child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  if (options.input !== undefined && child.stdin) {
    child.stdin.end(options.input);
  }

  const forwardSignals = options.forwardSignals ?? true;
  const onInterrupt = (signal: NodeJS.Signals): void => {
    const childSignal = options.signalMap?.[signal] ?? signal;
    if (!child.killed) child.kill(childSignal);
  };
  const onSigint = (): void => onInterrupt("SIGINT");
  const onSigterm = (): void => onInterrupt("SIGTERM");
  const removeSignalListeners = (): void => {
    if (!forwardSignals) return;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  if (forwardSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      removeSignalListeners();
      reject(new Error(`could not execute ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      removeSignalListeners();
      resolve({ exitCode: code ?? signalExitCode(signal), signal, stdout, stderr });
    });
  });
}

function isReadablePipe(
  stdio: ExecuteOptions["stdio"],
): stdio is [StdioPipe, StdioPipe, StdioPipe] | "pipe" {
  if (stdio === "pipe") return true;
  return Array.isArray(stdio) && (stdio[1] === "pipe" || stdio[2] === "pipe");
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
