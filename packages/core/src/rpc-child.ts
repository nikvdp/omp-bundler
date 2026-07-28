/**
 * RPC child process wrapper for `omp --mode rpc`.
 *
 * Spawns a child process, performs the protocol handshake (v1 default; the
 * child starts in v1 and emits a `ready` frame automatically), reads and
 * writes newline-delimited JSON frames, reassembles chunked v2 frames,
 * correlates responses by `id`, and exposes a typed async interface.
 *
 * Protocol contract:
 * - The child starts in protocol version 1 by default. The first frame it
 *   emits is `{"type":"ready",...}` with `maxFrameBytes` and
 *   `maxReassembledFrameBytes`. No `negotiate_protocol` command is needed.
 * - To use v2 (chunked frames), call {@link RpcChild.negotiateProtocolV2}.
 *   In v2 the server chunks its own large *outbound* frames; the client
 *   reassembles them. The client always writes single JSONL lines to stdin;
 *   the server has no inbound frame-size limit.
 * - Inbound `rpc_chunk` frames carry `chunkId`, `index`, `count` and must be
 *   reassembled into the original JSON frame. Chunks only arrive after v2
 *   negotiation.
 * - Commands carry an optional `id`; responses echo it as
 *   `{"type":"response","command":"...","success":true|false}`. Ordering
 *   across concurrent commands is not guaranteed; match on `id`.
 * - `bash` dispatches in the background so `abort_bash` can overtake; do not
 *   assume serial completion.
 * - `extension_ui_request` frames with dialog methods (`select`, `confirm`,
 *   `input`, `editor`) expect a response. Fire-and-forget methods (`setWidget`,
 *   `notify`, `setStatus`, `setTitle`, `set_editor_text`, `open_url`, `cancel`)
 *   do not. This wrapper auto-cancels dialog requests so the child never
 *   hangs waiting on a UI response no one will send.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  IS_UNIX,
  registerChild,
  unregisterChild,
  killProcessGroup,
  type ChildRegistryEntry,
} from "./child-reaper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Frame the child emits on startup. */
export interface RpcReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

/** Chunked transport frame (protocol v2, server to client only). */
export interface RpcChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/** A response frame correlated by `id`. */
export interface RpcResponseFrame {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** Extension UI request frame. Dialog methods expect a response. */
export interface RpcExtensionUiRequestFrame {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** Extension UI response frame (sent by us to the child). */
export interface RpcExtensionUiResponseFrame {
  type: "extension_ui_response";
  id: string;
  cancelled?: true;
  timedOut?: boolean;
  value?: string;
  confirmed?: boolean;
}

/** Event frame types surfaced to the consumer. */
export type RpcEventType =
  | "message_start"
  | "message_update"
  | "message_end"
  | "turn_start"
  | "turn_end"
  | "agent_end"
  | "subagent_lifecycle"
  | "subagent_progress"
  | "subagent_event"
  | "extension_ui_request";

/** A generic event frame: anything that is not a `response`, `ready`, `rpc_chunk`, or control frame. */
export interface RpcEventFrame {
  type: string;
  id?: string;
  [key: string]: unknown;
}

/** Callback for inbound event frames. */
export type RpcEventHandler = (event: RpcEventFrame) => void;

/** Callback for inbound `extension_ui_request` frames. */
export type ExtensionUiRequestHandler = (
  request: RpcExtensionUiRequestFrame,
) => RpcExtensionUiResponseFrame | undefined | void;

/** Options for constructing an {@link RpcChild}. */
export interface RpcChildOptions {
  /** Binary to spawn. Defaults to `"omp"`. */
  binary?: string;
  /** Extra args after `--mode rpc`. */
  args?: string[];
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment for the child. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Called for every inbound `extension_ui_request` frame. If it returns
   * a response frame, that frame is sent back to the child. If it returns
   * `undefined`, the default policy applies: dialog methods are auto-cancelled,
   * fire-and-forget methods are ignored. Replaces the default handler when
   * provided.
   */
  onExtensionUiRequest?: ExtensionUiRequestHandler;
  /** Timeout in ms for the initial `ready` frame. Defaults to 30_000. */
  readyTimeoutMs?: number;
  /**
   * Path to the persistent JSON registry that records this child's process
   * group. When set together with {@link conversationKey}, the pgid is
   * registered after spawn and removed after the child exits, so a crashed
   * supervisor can reclaim orphaned groups via {@link sweepChildRegistry}.
   * When omitted, the child still runs in its own process group but is not
   * persisted. Unix-only enforcement is on the registry helpers.
   */
  registryPath?: string;
  /**
   * Opaque, adapter-namespaced conversation key under which this child is
   * recorded in {@link registryPath}. Required for registry persistence.
   */
  conversationKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** Canonical non-empty base64 regex, matching the server's rpc-frame.ts decoder. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Methods of `extension_ui_request` that expect a response from the host.
 * The remaining methods (setWidget, notify, setStatus, setTitle,
 * set_editor_text, open_url, cancel) are fire-and-forget.
 */
const DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
};

// ---------------------------------------------------------------------------
// Chunk reassembly
// ---------------------------------------------------------------------------

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

// ---------------------------------------------------------------------------
// RpcChild
// ---------------------------------------------------------------------------

/**
 * A typed async wrapper around one `omp --mode rpc` child process.
 *
 * Lifecycle: call {@link start} (or the async constructor {@link create}) to
 * spawn the child and complete the handshake, then use {@link send} or the
 * typed command helpers ({@link getState}, {@link prompt}, etc.) to interact.
 * Call {@link close} to shut down cleanly.
 */
export class RpcChild extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: RpcReadyFrame | undefined;
  private protocolVersion = 1;
  private buffer = "";
  private pendingChunks = new Map<string, PendingChunks>();
  private pendingResponses = new Map<
    string,
    { resolve: (r: RpcResponseFrame) => void; reject: (e: Error) => void; command: string }
  >();
  private nextId = 1;
  private closed = false;
  /** Process group id of the child, equal to the child pid on Unix. */
  private pgid: number | undefined;
  private readonly opts: Required<
    Pick<RpcChildOptions, "binary" | "args" | "cwd" | "readyTimeoutMs">
  > &
    Pick<RpcChildOptions, "env" | "onExtensionUiRequest" | "registryPath" | "conversationKey">;

  constructor(options: RpcChildOptions = {}) {
    super();
    this.opts = {
      binary: options.binary ?? "omp",
      args: options.args ?? [],
      cwd: options.cwd ?? process.cwd(),
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      env: options.env,
      onExtensionUiRequest: options.onExtensionUiRequest,
      registryPath: options.registryPath,
      conversationKey: options.conversationKey,
    };
  }

  // ---- lifecycle ----

  /** Spawn the child and wait for the `ready` frame. Resolves with the ready frame. */
  async start(): Promise<RpcReadyFrame> {
    if (this.child) throw new Error("RpcChild already started");
    if (this.closed) throw new Error("RpcChild is closed");

    const args = ["--mode", "rpc", ...this.opts.args];
    // Spawn the child in its own process group on Unix so the entire tree
    // (child + any descendants) can be torn down together by signalling the
    // negative pgid. `detached: true` makes the child's pid its pgid. On
    // non-Unix we spawn without a separate group; hard group teardown is
    // then unavailable (see {@link hardKillPg} / sweepChildRegistry).
    const detached = IS_UNIX;
    const child = spawn(this.opts.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      detached,
    });
    this.child = child;

    if (detached && child.pid !== undefined) {
      this.pgid = child.pid;
    }

    // Register the process group in the persistent registry so a crashed
    // supervisor can reclaim it. Best-effort: a registration failure does not
    // block the child from running, but is surfaced as an "error" event.
    void this.registerPgid();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.onStdoutData(data));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      // Surface stderr as a diagnostic event; the protocol channel is stdout.
      this.emit("stderr", data);
    });
    child.on("error", (err) => {
      this.emit("error", err);
      this.rejectAllPending(err);
    });
    child.on("exit", (code, signal) => {
      const err = new Error(
        `omp rpc child exited (code=${code}, signal=${signal ?? "null"})`,
      );
      this.emit("exit", code, signal);
      // Unregister the process group after the child has confirmed exited.
      void this.unregisterPgid();
      if (!this.closed) {
        this.closed = true;
        this.rejectAllPending(err);
      }
    });

    const { promise: readyPromise, resolve: readyResolve, reject: readyReject } =
      Promise.withResolvers<RpcReadyFrame>();
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      this.off("ready", onReady);
      this.off("exit", onExit);
      this.off("error", onError);
    };
    const onReady = (frame: RpcReadyFrame) => {
      cleanup();
      readyResolve(frame);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      readyReject(
        new Error(
          `omp rpc child exited before ready (code=${code}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const onError = (err: Error) => {
      cleanup();
      readyReject(err);
    };
    timer = setTimeout(() => {
      cleanup();
      readyReject(new Error("omp rpc child timed out waiting for ready frame"));
      try {
        if (this.pgid !== undefined) {
          this.hardKillPg("SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
    }, this.opts.readyTimeoutMs);

    this.once("ready", onReady);
    this.once("exit", onExit);
    this.once("error", onError);
    return readyPromise;
  }

  /** Negotiate protocol version 2 (enables server-side outbound chunking). */
  async negotiateProtocolV2(): Promise<void> {
    const res = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!res.success) {
      throw new Error(`negotiate_protocol v2 failed: ${res.error ?? "unknown"}`);
    }
    this.protocolVersion = 2;
  }

  /** Close the child process. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const child = this.child;
    if (!child) return;

    this.rejectAllPending(new Error("RpcChild closed"));

    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    const { promise: exitPromise, resolve: exitResolve } = Promise.withResolvers<void>();
    const onExit = () => {
      clearTimeout(timer);
      exitResolve();
    };
    const timer = setTimeout(() => {
      // Graceful exit didn't happen; hard-kill the entire process group on
      // Unix (signals the negative pgid). On non-Unix or when no group was
      // established, fall back to killing the child pid directly.
      try {
        if (this.pgid !== undefined) {
          this.hardKillPg("SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      exitResolve();
    }, 5_000);
    child.once("exit", onExit);
    // If already exited.
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      // Group already reaped in the exit handler; just resolve.
      exitResolve();
    }
    await exitPromise;
  }

  // ---- process-group reaping ----

  /** Process group id of the child, or `undefined` if not spawned / non-Unix. */
  get processGroupId(): number | undefined {
    return this.pgid;
  }

  /**
   * Hard-kill the entire child process group by signalling the negative pgid.
   *
   * This tears down the child AND any descendant processes it spawned, which a
   * plain `child.kill()` cannot reach. Intended for crash handling and as the
   * fallback after graceful {@link close} times out.
   *
   * @returns `true` if the signal was delivered, `false` if the group was
   *          already gone. Throws {@link UnsupportedPlatformError} off-Unix or
   *          `Error` if no process group was ever established (non-detached
   *          spawn).
   */
  hardKillPg(signal: NodeJS.Signals = "SIGKILL"): boolean {
    if (this.pgid === undefined) {
      // No process group (non-Unix spawn or never started): callers should
      // fall back to `child.kill()`. Signal this distinctly.
      throw new Error("RpcChild has no process group (non-Unix or not started)");
    }
    return killProcessGroup(this.pgid, signal);
  }

  /**
   * Register this child's process group in the persistent registry. Best-effort
   * (non-throwing): a registry failure is surfaced as an "error" event but does
   * not prevent the child from running. Requires both `registryPath` and
   * `conversationKey` to be set; otherwise a no-op.
   */
  private async registerPgid(): Promise<void> {
    const { registryPath, conversationKey } = this.opts;
    if (!registryPath || !conversationKey || this.pgid === undefined) return;
    const entry: ChildRegistryEntry = {
      pgid: this.pgid,
      pid: this.pgid,
      startedAt: Date.now(),
      binary: this.opts.binary,
    };
    try {
      await registerChild(registryPath, conversationKey, entry);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Remove this child's process group from the persistent registry. Called
   * after the child has confirmed exited (the `exit` handler). No-op if no
   * registry is configured. Best-effort: failures are surfaced but swallowed.
   */
  private async unregisterPgid(): Promise<void> {
    const { registryPath, conversationKey } = this.opts;
    if (!registryPath || !conversationKey || this.pgid === undefined) return;
    try {
      await unregisterChild(registryPath, conversationKey);
    } catch {
      // Swallow: the group is already dead; a stale entry will be cleared by
      // the next startup sweep.
    }
  }

  // ---- core send / receive ----

  /**
   * Send a command frame and await the correlated response.
   * An `id` is auto-assigned if not provided.
   *
   * The frame is written as a single newline-delimited JSON line. The server
   * reads stdin line-by-line with no frame-size limit, so outbound chunking
   * is never needed.
   */
  send<T = unknown>(frame: Record<string, unknown>): Promise<RpcResponseFrame & { data?: T }> {
    if (!this.child) return Promise.reject(new Error("RpcChild not started"));
    if (this.closed) return Promise.reject(new Error("RpcChild is closed"));

    const id = typeof frame.id === "string" ? frame.id : String(this.nextId++);
    const payload: Record<string, unknown> = { ...frame, id };
    const command = String(payload.type ?? "unknown");

    const { promise: sendPromise, resolve: sendResolve, reject: sendReject } =
      Promise.withResolvers<RpcResponseFrame & { data?: T }>();
    this.pendingResponses.set(id, {
      resolve: sendResolve as (r: RpcResponseFrame) => void,
      reject: sendReject,
      command,
    });
    try {
      this.writeRaw(JSON.stringify(payload) + "\n");
    } catch (err) {
      this.pendingResponses.delete(id);
      sendReject(err instanceof Error ? err : new Error(String(err)));
    }
    return sendPromise;
  }

  /**
   * Send a frame without awaiting a response (e.g. `abort_bash`, `steer`,
   * `extension_ui_response`). No `id` is auto-assigned.
   */
  sendRaw(frame: object): void {
    this.writeRaw(JSON.stringify(frame) + "\n");
  }

  /** Low-level newline-delimited JSON line writer with backpressure. */
  private writeRaw(line: string): void {
    if (!this.child || this.closed) return;
    try {
      if (!this.child.stdin.write(line)) {
        this.child.stdin.once("drain", () => {});
      }
    } catch {
      // ignore: child may already be dead
    }
  }

  /** Register a handler for all inbound event frames. */
  onEvent(handler: RpcEventHandler): void {
    this.on("event", handler);
  }

  // ---- typed command helpers ----

  /** `get_state`: returns the current session state. */
  getState(): Promise<RpcResponseFrame & { data?: RpcSessionState }> {
    return this.send({ type: "get_state" });
  }

  /**
   * `prompt`: send a user message and let the agent produce a turn. Event
   * frames (message_start, message_update, message_end, turn_start, turn_end,
   * agent_end, subagent_*) stream via {@link onEvent} / the `event` emitter.
   * The response resolves when the prompt command is acknowledged (before the
   * full turn completes for streaming behavior).
   */
  prompt(
    message: string,
    options: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" } = {},
  ): Promise<RpcResponseFrame> {
    return this.send({
      type: "prompt",
      message,
      ...(options.images ? { images: options.images } : {}),
      ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  /** `abort`: abort the current turn. */
  abort(): Promise<RpcResponseFrame> {
    return this.send({ type: "abort" });
  }

  /** `bash`: run a shell command in the background. Response arrives later. */
  bash(command: string): Promise<RpcResponseFrame> {
    return this.send({ type: "bash", command });
  }

  /** `abort_bash`: abort a running bash command. Sent as raw (no id needed). */
  abortBash(): void {
    this.sendRaw({ type: "abort_bash" });
  }

  /** `switch_session`: switch to an existing session by path. */
  switchSession(sessionPath: string): Promise<RpcResponseFrame> {
    return this.send({ type: "switch_session", sessionPath });
  }

  /** `new_session`: create a new session, optionally branching from a parent. */
  newSession(parentSession?: string): Promise<RpcResponseFrame> {
    return this.send({
      type: "new_session",
      ...(parentSession ? { parentSession } : {}),
    });
  }

  /** `get_messages`: retrieve all messages. */
  getMessages(): Promise<RpcResponseFrame> {
    return this.send({ type: "get_messages" });
  }

  // ---- internals ----

  private onStdoutData(data: string): void {
    this.buffer += data;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed line: emit a diagnostic and continue (issue #5194 parity).
      this.emit("parse_error", line);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;

    const frame = parsed as Record<string, unknown>;

    // Chunk reassembly.
    if (frame.type === "rpc_chunk") {
      const reassembled = this.processChunk(frame as unknown as RpcChunkFrame);
      if (!reassembled) return;
      return this.processFrame(reassembled);
    }

    this.processFrame(frame);
  }

  /**
   * Reassemble one inbound `rpc_chunk` frame, matching the decoder invariants
   * in OMP `src/modes/rpc/rpc-frame.ts` exactly. Chunks only arrive after v2
   * negotiation; any `rpc_chunk` before that is rejected.
   */
  private processChunk(chunk: RpcChunkFrame): Record<string, unknown> | undefined {
    // rpc_chunk frames are only valid after v2 negotiation.
    if (this.protocolVersion < 2) {
      this.emit("error", new Error("rpc_chunk received before v2 negotiation"));
      return undefined;
    }

    const { chunkId, index, count, byteLength } = chunk;

    // ---- strict metadata validation (mirrors rpc-frame.ts RpcFrameDecoder.push) ----
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128
    ) {
      this.emit("error", new Error("invalid rpc_chunk chunkId"));
      return undefined;
    }
    if (!Number.isSafeInteger(index) || index < 0) {
      this.emit("error", new Error("invalid rpc_chunk index"));
      return undefined;
    }
    if (!Number.isSafeInteger(count) || count < 2) {
      this.emit("error", new Error("invalid rpc_chunk count"));
      return undefined;
    }
    if (index >= count) {
      this.emit("error", new Error("rpc_chunk index out of range"));
      return undefined;
    }
    const maxReassembled =
      this.ready?.maxReassembledFrameBytes ?? DEFAULT_MAX_REASSEMBLED_BYTES;
    const maxCount = Math.ceil(maxReassembled / CHUNK_PAYLOAD_BYTES);
    if (count > maxCount) {
      this.emit("error", new Error(`rpc_chunk count exceeds maximum (${count} > ${maxCount})`));
      return undefined;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      this.emit("error", new Error("invalid rpc_chunk byteLength"));
      return undefined;
    }
    const maxFrame = this.ready?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (byteLength < maxFrame) {
      this.emit("error", new Error(`rpc_chunk byteLength must be >= maxFrameBytes (${byteLength} < ${maxFrame})`));
      return undefined;
    }
    if (byteLength > maxReassembled) {
      this.emit("error", new Error(`rpc_chunk byteLength exceeds maxReassembledFrameBytes (${byteLength} > ${maxReassembled})`));
      return undefined;
    }

    // ---- sequence tracking ----
    let pending = this.pendingChunks.get(chunkId);
    if (!pending) {
      if (index !== 0) {
        this.emit("error", new Error("rpc_chunk sequence must start at index 0"));
        return undefined;
      }
      pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
      this.pendingChunks.set(chunkId, pending);
    }

    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      this.emit("error", new Error("rpc_chunk sequence mismatch"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }

    // ---- payload validation before accumulation ----
    if (typeof chunk.data !== "string" || chunk.data.length === 0 || !BASE64_RE.test(chunk.data)) {
      this.emit("error", new Error("invalid rpc_chunk base64 data"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }
    const bytes = Buffer.from(chunk.data, "base64");
    // Round-trip check: the re-encoded base64 must match the input exactly.
    if (bytes.toString("base64") !== chunk.data) {
      this.emit("error", new Error("rpc_chunk base64 round-trip mismatch"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }
    if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) {
      this.emit("error", new Error("rpc_chunk payload exceeds transport limit"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }

    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > pending.byteLength) {
      this.emit("error", new Error("rpc_chunk accumulated bytes exceed declared byteLength"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }

    pending.chunks.push(bytes);
    pending.nextIndex++;

    if (pending.nextIndex < pending.count) return undefined;

    if (pending.receivedBytes !== pending.byteLength) {
      this.emit("error", new Error("rpc_chunk length mismatch"));
      this.pendingChunks.delete(chunkId);
      return undefined;
    }

    this.pendingChunks.delete(chunkId);
    try {
      // Fatal UTF-8 decode: invalid sequences throw rather than produce mojibake.
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(pending.chunks),
      );
      const frame = JSON.parse(decoded);
      if (typeof frame !== "object" || frame === null) {
        this.emit("error", new Error("reassembled frame is not an object"));
        return undefined;
      }
      return frame as Record<string, unknown>;
    } catch {
      this.emit("error", new Error("failed to parse reassembled frame"));
      return undefined;
    }
  }

  private processFrame(frame: Record<string, unknown>): void {
    const type = frame.type;

    if (type === "ready") {
      this.ready = frame as unknown as RpcReadyFrame;
      this.emit("ready", this.ready);
      return;
    }

    if (type === "response") {
      const response = frame as unknown as RpcResponseFrame;
      const id = response.id;
      if (id !== undefined) {
        const pending = this.pendingResponses.get(id);
        if (pending) {
          this.pendingResponses.delete(id);
          pending.resolve(response);
        } else {
          // Response with no matching pending: surface as an event.
          this.emit("orphan_response", response);
        }
      } else {
        this.emit("orphan_response", response);
      }
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(frame as unknown as RpcExtensionUiRequestFrame);
      return;
    }

    // Everything else is an event frame (message_start, message_update, etc.).
    this.emit("event", frame as unknown as RpcEventFrame);
  }

  private handleExtensionUiRequest(request: RpcExtensionUiRequestFrame): void {
    // Surface to the consumer via the event channel.
    this.emit("event", request as unknown as RpcEventFrame);

    // Let a custom handler decide.
    if (this.opts.onExtensionUiRequest) {
      const response = this.opts.onExtensionUiRequest(request);
      if (response) {
        this.sendRaw(response);
        return;
      }
      // If the custom handler returned undefined, fall through to default.
    }

    // Default policy: auto-cancel dialog methods so the child never hangs.
    // Fire-and-forget methods need no response.
    if (DIALOG_METHODS[request.method]) {
      const cancel: RpcExtensionUiResponseFrame = {
        type: "extension_ui_response",
        id: request.id,
        cancelled: true,
      };
      this.sendRaw(cancel);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(err);
    }
    this.pendingResponses.clear();
  }
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/** Spawn a child and await the `ready` frame. Returns a ready-to-use {@link RpcChild}. */
export async function createRpcChild(
  options?: RpcChildOptions,
): Promise<{ child: RpcChild; ready: RpcReadyFrame }> {
  const child = new RpcChild(options);
  const ready = await child.start();
  return { child, ready };
}

// ---------------------------------------------------------------------------
// Re-exported session state type (subset of what get_state returns)
// ---------------------------------------------------------------------------

export interface RpcSessionState {
  model?: unknown;
  thinkingLevel?: unknown;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  interruptMode: "immediate" | "wait";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  queuedMessageCount: number;
  todoPhases?: unknown[];
  [key: string]: unknown;
}