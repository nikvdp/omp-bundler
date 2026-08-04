import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { optionString } from "../args.ts";
import { loadProject, resolveDefaultEnvFile } from "../project.ts";
import type { CommandContext, CommandHandler, ParsedArguments } from "../types.ts";
import { getDockerEnvValue } from "./check.ts";
import { assertAllowedOptions } from "./common.ts";
import { discoverPublishedAdapterPort, resolveRunSettings } from "./run.ts";

export const TUI_HELP = `omp-bundler tui [--dir <bundle-path>] [--endpoint <agent-url>]

Open a simple terminal chat for a running bundle. With no flags, use the current
bundle's root agent. --dir selects another bundle, and --endpoint bypasses
bundle discovery with an exact agent URL.`;

export interface TuiTarget {
  readonly endpoint: string;
  readonly token?: string;
}

export const tuiCommand: CommandHandler = async (args, context) => {
  if (args.options.help === true) {
    context.io.stdout.write(`${TUI_HELP}\n`);
    return 0;
  }
  assertAllowedOptions(args, ["dir", "endpoint"]);
  if (args.positionals.length > 0) throw new Error(`usage: ${TUI_HELP.split("\n", 1)[0]}`);

  return runReadlineChat(await resolveTuiTarget(args, context.cwd), context);
};

export async function resolveTuiTarget(
  args: ParsedArguments,
  cwd: string,
  discoverPort: (bundleRoot: string, containerName: string) => Promise<number | undefined> = discoverPublishedAdapterPort,
): Promise<TuiTarget> {
  const directory = requiredStringOption(args, "dir");
  const endpoint = requiredStringOption(args, "endpoint");
  if (endpoint !== undefined) {
    if (directory !== undefined) throw new Error("--endpoint cannot be combined with --dir");
    const token = process.env.OMP_HTTP_API_TOKEN;
    return {
      endpoint: normalizeAgentEndpoint(endpoint),
      ...(token === undefined ? {} : { token }),
    };
  }

  const project = await loadProject(directory, cwd);
  const settings = resolveRunSettings({ project });
  const adapterPort = await discoverPort(project.rootDir, settings.containerName) ?? settings.adapterPort;
  const envFile = await resolveDefaultEnvFile(project.rootDir);
  let token: string | undefined;
  if (envFile !== undefined) {
    token = getDockerEnvValue(await readFile(envFile, "utf8"), envFile, "OMP_HTTP_API_TOKEN") ?? "";
  }
  return {
    endpoint: `http://localhost:${adapterPort}/v1/agents/${encodeURIComponent(project.agent.id)}`,
    ...(token === undefined ? {} : { token }),
  };
}

export async function runReadlineChat(
  target: TuiTarget,
  context: CommandContext,
  request: typeof fetch = fetch,
): Promise<number> {
  const endpoint = normalizeAgentEndpoint(target.endpoint);
  const conversationKey = randomUUID();
  const readline = createInterface({ input: context.io.stdin, output: context.io.stdout });
  let activeRequest: AbortController | undefined;
  let interrupted = false;
  readline.on("SIGINT", () => {
    interrupted = true;
    activeRequest?.abort();
    readline.close();
  });
  context.io.stdout.write(`Chatting with ${endpoint}\nType /quit to exit.\n\n`);

  try {
    while (!interrupted) {
      let message: string;
      try {
        message = (await readline.question("you> ")).trim();
      } catch {
        break;
      }
      if (!message) continue;
      if (/^\/(?:quit|exit)$/i.test(message)) break;

      activeRequest = new AbortController();
      const stopSpinner = startSpinner(context.io.stderr);
      try {
        const response = await request(
          `${endpoint}/conversations/${encodeURIComponent(conversationKey)}/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
            },
            body: JSON.stringify({ message }),
            signal: activeRequest.signal,
          },
        );
        const body = await response.text();
        if (!response.ok) throw new Error(serverError(response.status, body));
        const parsed: unknown = JSON.parse(body);
        const text = responseText(parsed);
        if (text === undefined) throw new Error("agent response did not contain text");
        stopSpinner();
        context.io.stdout.write(`agent> ${text}\n\n`);
      } catch (error) {
        stopSpinner();
        if (interrupted) break;
        context.io.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        activeRequest = undefined;
      }
    }
  } finally {
    readline.close();
  }
  return 0;
}

function requiredStringOption(args: ParsedArguments, name: string): string | undefined {
  if (!Object.hasOwn(args.options, name)) return undefined;
  const value = optionString(args, name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} requires a value`);
  return value;
}

function normalizeAgentEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`invalid agent endpoint: ${raw}`);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("agent endpoint must use http or https");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("agent endpoint must not contain credentials, query parameters, or a fragment");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  if (!/\/v1\/agents\/[^/]+$/.test(endpoint.pathname)) {
    throw new Error("agent endpoint must end with /v1/agents/<agent-id>");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function startSpinner(output: Writable): () => void {
  const terminal = "isTTY" in output && output.isTTY === true;
  if (!terminal) {
    output.write("Waiting for agent...\n");
    return () => {};
  }
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  output.write(`Waiting for agent... ${frames[frame]}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    output.write(`\rWaiting for agent... ${frames[frame]}`);
  }, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    output.write("\r\u001b[2K");
  };
}

function responseText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("text" in value)) return undefined;
  return typeof value.text === "string" ? value.text : undefined;
}

function serverError(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = parsed.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
      }
    }
  } catch {
    // Use the bounded fallback below.
  }
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 512);
  return excerpt ? `HTTP ${status}: ${excerpt}` : `HTTP ${status}`;
}
