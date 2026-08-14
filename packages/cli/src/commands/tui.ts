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
      if (interrupted) break;
      if (!message) continue;
      if (/^\/(?:quit|exit)$/i.test(message)) break;

      activeRequest = new AbortController();
      const stopSpinner = startSpinner(context.io.stderr);
      const renderState: StreamRenderState = {
        renderedText: "",
        prefixWritten: false,
        stopSpinner: once(stopSpinner),
      };
      try {
        const response = await request(
          `${endpoint}/conversations/${encodeURIComponent(conversationKey)}/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
            },
            body: JSON.stringify({ message }),
            signal: activeRequest.signal,
          },
        );
        if (!response.ok) {
          throw new Error(serverError(response.status, await response.text()));
        }

        if (isEventStream(response)) {
          if (response.body === null) {
            throw new StreamProtocolError("stream response did not contain a body");
          }
          await consumeEventStream(
            response.body,
            activeRequest.signal,
            (event) => renderStreamEvent(event, renderState, context.io.stdout),
          );
        } else {
          const parsed: unknown = JSON.parse(await response.text());
          const text = responseText(parsed);
          if (text === undefined) throw new Error("agent response did not contain text");
          renderState.stopSpinner();
          context.io.stdout.write(`agent> ${text}\n\n`);
        }
      } catch (error) {
        renderState.stopSpinner();
        if (interrupted || activeRequest.signal.aborted) break;
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

interface StreamRenderState {
  renderedText: string;
  prefixWritten: boolean;
  stopSpinner: () => void;
}

interface SseEvent {
  readonly type: string;
  readonly data: unknown;
}

class StreamProtocolError extends Error {
  constructor(detail: string) {
    super(`agent event stream protocol error: ${detail}`);
    this.name = "StreamProtocolError";
  }
}

class IncrementalSseParser {
  private bufferedText = "";
  private eventName = "";
  private dataLines: string[] = [];
  private terminalSeen = false;
  private readonly onEvent: (event: SseEvent) => void;

  constructor(onEvent: (event: SseEvent) => void) {
    this.onEvent = onEvent;
  }

  feed(text: string): void {
    this.bufferedText += text;
    let newlineIndex = this.bufferedText.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.bufferedText.slice(0, newlineIndex);
      this.bufferedText = this.bufferedText.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line);
      newlineIndex = this.bufferedText.indexOf("\n");
    }
  }

  finish(): void {
    if (this.bufferedText.length > 0) {
      throw new StreamProtocolError("stream ended in the middle of an SSE line");
    }
    if (this.eventName.length > 0 || this.dataLines.length > 0) {
      throw new StreamProtocolError("stream ended before an SSE frame terminator");
    }
    if (!this.terminalSeen) {
      throw new StreamProtocolError("stream ended before a completed or error event");
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) {
      this.dispatchFrame();
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
      case "retry":
        break;
      default:
        throw new StreamProtocolError(`unsupported SSE field "${field}"`);
    }
  }

  private dispatchFrame(): void {
    if (this.eventName.length === 0 && this.dataLines.length === 0) return;
    if (this.terminalSeen) {
      throw new StreamProtocolError("received an event after the terminal event");
    }
    if (this.eventName.length === 0) {
      throw new StreamProtocolError("SSE frame is missing an event type");
    }
    if (this.dataLines.length === 0) {
      throw new StreamProtocolError(`SSE "${this.eventName}" frame is missing data`);
    }

    const type = this.eventName;
    const payload = this.dataLines.join("\n");
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new StreamProtocolError(`SSE "${type}" frame contains invalid JSON data`);
    }
    this.eventName = "";
    this.dataLines = [];
    if (type === "completed" || type === "error" || type === "cancelled")
      this.terminalSeen = true;
    this.onEvent({ type, data });
  }
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  let aborted = signal.aborted;
  const abort = (): void => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (aborted) abort();

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parser = new IncrementalSseParser(onEvent);
  try {
    while (!aborted) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        if (aborted || signal.aborted) return;
        throw new StreamProtocolError(
          `stream read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (aborted || signal.aborted) return;
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new StreamProtocolError("stream yielded a non-byte chunk");
      }
      let text: string;
      try {
        text = decoder.decode(result.value, { stream: true });
      } catch {
        throw new StreamProtocolError("stream contained invalid UTF-8");
      }
      parser.feed(text);
    }
    if (aborted || signal.aborted) return;
    try {
      parser.feed(decoder.decode());
    } catch (error) {
      if (error instanceof StreamProtocolError) throw error;
      throw new StreamProtocolError("stream contained invalid UTF-8");
    }
    parser.finish();
  } catch (error) {
    if (aborted || signal.aborted) return;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function renderStreamEvent(
  event: SseEvent,
  state: StreamRenderState,
  output: Writable,
): void {
  switch (event.type) {
    case "accepted":
    case "progress":
      streamObject(event);
      return;
    case "delta": {
      const data = streamObject(event);
      const text = data.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new StreamProtocolError("delta event must contain non-empty text");
      }
      state.stopSpinner();
      if (!state.prefixWritten) {
        output.write("agent> ");
        state.prefixWritten = true;
      }
      output.write(text);
      state.renderedText += text;
      return;
    }
    case "completed": {
      const data = streamObject(event);
      if (typeof data.text !== "string") {
        throw new StreamProtocolError("completed event must contain text");
      }
      state.stopSpinner();
      if (!state.prefixWritten) {
        output.write("agent> ");
        state.prefixWritten = true;
      }
      if (data.text.startsWith(state.renderedText)) {
        const suffix = data.text.slice(state.renderedText.length);
        if (suffix.length > 0) output.write(suffix);
      } else {
        output.write("\n[agent response corrected]\n");
        output.write(data.text);
      }
      output.write("\n\n");
      state.renderedText = data.text;
      return;
    }
    // The turn was superseded before it answered. Terminal output cannot be
    // unprinted, so mark the abandoned partial rather than leaving it looking
    // like a finished answer, and return to the prompt without an error: a
    // newer message is already being handled.
    case "cancelled": {
      state.stopSpinner();
      if (state.prefixWritten) {
        output.write("\n[interrupted]\n\n");
      }
      state.renderedText = "";
      return;
    }
    case "error": {
      const data = streamObject(event);
      const message = streamErrorMessage(data);
      state.stopSpinner();
      throw new Error(message);
    }
    default:
      throw new StreamProtocolError(`unsupported event "${event.type}"`);
  }
}

function streamObject(event: SseEvent): Record<string, unknown> {
  if (
    event.data === null ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  ) {
    throw new StreamProtocolError(`${event.type} event data must be an object`);
  }
  return event.data as Record<string, unknown>;
}

function streamErrorMessage(data: Record<string, unknown>): string {
  if (typeof data.message === "string" && data.message.length > 0) return data.message;
  if (typeof data.error === "string" && data.error.length > 0) return data.error;
  if (
    data.error !== null &&
    typeof data.error === "object" &&
    !Array.isArray(data.error) &&
    typeof (data.error as Record<string, unknown>).message === "string" &&
    ((data.error as Record<string, unknown>).message as string).length > 0
  ) {
    return (data.error as Record<string, unknown>).message as string;
  }
  throw new StreamProtocolError("error event must contain a message");
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
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
