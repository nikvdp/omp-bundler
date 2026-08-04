import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { optionString } from "../args.ts";
import { requirePackagedAsset } from "../assets.ts";
import { assertSafeIdentifier } from "../identifiers.ts";
import { executeChild } from "../process.ts";
import { discoverAgents, loadProject, resolveDefaultEnvFile } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";
import { getDockerEnvValue } from "./check.ts";
import { assertAllowedOptions } from "./common.ts";
import { resolveRunSettings } from "./run.ts";

export const TUI_HELP = `omp-bundler tui [--dir <bundle-path>] [--id <agent-id>] [--endpoint <agent-url>]

Open terminal chat for a running bundle. With no flags, use the current bundle
and infer its only agent. --dir selects another bundle, --id selects one agent,
and --endpoint bypasses bundle discovery with an exact agent URL.`;

export interface TuiTarget {
  readonly endpoint: string;
  readonly token?: string;
}

export const tuiCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${TUI_HELP}\n`);
    return 0;
  }
  assertAllowedOptions(args, ["dir", "id", "endpoint"]);
  if (args.positionals.length > 0) throw new Error(`usage: ${TUI_HELP.split("\n", 1)[0]}`);

  const target = await resolveTuiTarget(args, context.cwd);
  const executable = await resolveTuiExecutable();
  const result = await executeChild(executable, [target.endpoint], {
    stdio: "inherit",
    ...(target.token === undefined ? {} : { env: { OMP_HTTP_API_TOKEN: target.token } }),
  });
  return result.exitCode;
};

export async function resolveTuiTarget(args: ParsedArguments, cwd: string): Promise<TuiTarget> {
  const directory = requiredStringOption(args, "dir");
  const agentId = requiredStringOption(args, "id");
  const endpoint = requiredStringOption(args, "endpoint");
  if (endpoint !== undefined) {
    if (directory !== undefined || agentId !== undefined) {
      throw new Error("--endpoint cannot be combined with --dir or --id");
    }
    return { endpoint };
  }

  const project = await loadProject(directory, cwd);
  const agents = await discoverAgents(project.agentsDir);
  let selectedId = agentId;
  if (selectedId !== undefined) {
    assertSafeIdentifier(selectedId, "agent id");
    if (!agents.some((agent) => agent.id === selectedId)) {
      throw new Error(`agent '${selectedId}' is not a direct child of ${project.agentsDir}`);
    }
  } else if (agents.length === 1) {
    selectedId = agents[0].id;
  } else if (agents.length === 0) {
    throw new Error(`bundle has no agents: ${project.rootDir}`);
  } else {
    throw new Error(`bundle has multiple agents (${agents.map((agent) => agent.id).join(", ")}); select one with --id`);
  }

  const { adapterPort } = resolveRunSettings({ project });
  const envFile = await resolveDefaultEnvFile(project.rootDir);
  let token: string | undefined;
  if (envFile !== undefined) {
    token = getDockerEnvValue(await readFile(envFile, "utf8"), envFile, "OMP_HTTP_API_TOKEN") ?? "";
  }
  return {
    endpoint: `http://localhost:${adapterPort}/v1/agents/${encodeURIComponent(selectedId)}`,
    ...(token === undefined ? {} : { token }),
  };
}

function requiredStringOption(args: ParsedArguments, name: string): string | undefined {
  if (!Object.hasOwn(args.options, name)) return undefined;
  const value = optionString(args, name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} requires a value`);
  return value;
}

async function resolveTuiExecutable(): Promise<string> {
  const target = `${process.platform}-${process.arch}`;
  const encodedPath = await requirePackagedAsset(`tools/omp-tui/${target}.base64`);
  const encoded = await readFile(encodedPath, "utf8");
  const digest = createHash("sha256").update(encoded).digest("hex").slice(0, 16);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = join(homedir(), ".cache", "omp-bundler", "bin", `omp-tui-${target}-${digest}${suffix}`);
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    // Extract below.
  }

  await mkdir(dirname(executable), { recursive: true });
  const temporary = `${executable}.${process.pid}.tmp`;
  await writeFile(temporary, Buffer.from(encoded, "base64"), { mode: 0o700 });
  try {
    await rename(temporary, executable);
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(executable, 0o700);
  return executable;
}
