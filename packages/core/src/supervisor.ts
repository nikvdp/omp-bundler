/**
 * CoreSupervisor: composes every leaf module into a single inbound-processing
 * and outbound-delivery runtime for the omp-bundler v1 adapter API.
 *
 * Composition
 * ------------
 * The supervisor owns one of each leaf and wires them together:
 * - {@link AdapterRegistry}: declarative adapter registrations + auth/signing.
 * - {@link SessionRegistry}: persistent (adapterId, conversationKey) -> session file.
 * - {@link IdempotencyStore}: exact idempotency for inbound messages.
 * - {@link IngestBuffer}: per-conversation activation state machine.
 * - {@link PoolManager}: bounded child-process lease pool.
 * - {@link RpcChild} factory: spawns `omp --mode rpc` with the ambient
 *   ingest extension and the staged agent folder.
 * - {@link OutboundEmitter}: per-correlation frame-to-event mapping + delivery.
 *
 * Inbound processing
 * ------------------
 * Each inbound message is classified by the idempotency store:
 * - `created`: new correlation. Ambient outside engagement appends one passive
 *   agent-attributed message (via the ambient extension command) with zero LLM
 *   turn. Addressed activates, flushing backlog by ancestry only (previous
 *   passive records are NOT duplicated into the prompt). Active addressed
 *   steers; active ambient is an agent-attributed follow-up. One correlation
 *   is preserved across buffered backlog + current messages.
 * - `pending` / `already-sent` / `response-saved` / `delivery-failed`: duplicate
 *   acceptance is returned without another append/turn. Saved/failed terminal
 *   responses are redelivered through the emitter without another agent turn.
 *
 * RPC lifecycle
 * -------------
 * Child event frames are routed into versioned OutboundEvents via the
 * OutboundEmitter. `turn.started` is emitted on the first `turn_start`;
 * best-effort `turn.progress` from assistant text deltas; terminalize on
 * `agent_end` (not `turn_end`). Queued ambient follow-up runs are tracked so
 * the first `agent_end` does not prematurely close a correlation. The lease
 * is released only on terminal completion or failure. Terminal delivery hooks
 * save/mark failure/sent across every message id in the correlation group.
 *
 * All event sequencing and delivery goes through the OutboundEmitter; the
 * supervisor never POSTs directly.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

import type { InboundMessage } from "@omp-bundler/contracts/inbound";
import type { OutboundEvent } from "@omp-bundler/contracts/outbound";

import { AdapterRegistry, type AdapterRegistration } from "./adapter-registry.js";
import { SessionRegistry } from "./session-registry.js";
import {
  IdempotencyStore,
  IdempotencyConflictError,
  type IdempotencyEntry,
} from "./idempotency-store.js";
import {
  IngestBuffer,
  type ActivationMode,
  renderRecord,
} from "./ingest-buffer.js";
import { PoolManager, type ChildFactory, type Lease } from "./pool-manager.js";
import {
  RpcChild,
  type RpcEventFrame,
  type RpcResponseFrame,
} from "./rpc-child.js";
import {
  OutboundEmitter,
  type AdapterTarget,
  type PendingOutboundCorrelation,
  listPendingOutboundCorrelations,
} from "./outbound-emitter.js";
import { AMBIENT_INGEST_COMMAND } from "./ambient-ingest-extension.js";
import type { CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable clock returning epoch milliseconds. */
export type Clock = () => number;

/** Injectable fetch implementation (defaults to global fetch). */
export type FetchImpl = typeof fetch;

/** Injectable child factory for tests. */
export type ChildFactoryFn = ChildFactory;

/** Result of processing an inbound message. */
export type InboundResult =
  | { kind: "accepted"; correlationId: string; status: "accepted" }
  | { kind: "duplicate"; correlationId: string; status: "duplicate" };

/**
 * Thrown when the idempotency store detects a payload conflict. The HTTP
 * layer maps this to 409.
 */
export class InboundConflictError extends Error {
  readonly adapterId: string;
  readonly messageId: string;
  constructor(adapterId: string, messageId: string) {
    super(
      `idempotency conflict for adapter="${adapterId}" message="${messageId}"`,
    );
    this.name = "InboundConflictError";
    this.adapterId = adapterId;
    this.messageId = messageId;
  }
}

// ---------------------------------------------------------------------------
// Per-conversation active correlation state
// ---------------------------------------------------------------------------

interface ActiveCorrelation {
  /** The correlation id shared across all message ids in this group. */
  correlationId: string;
  /** The adapter id. */
  adapterId: string;
  /** The conversation key. */
  conversationKey: string;
  /** All message ids in the correlation group (for terminal delivery hooks). */
  messageIds: Set<string>;
  /** The OutboundEmitter for this correlation. */
  emitter: OutboundEmitter;
  /** The currently held pool lease. */
  lease: Lease | null;
  /** Number of queued ambient follow-up runs not yet terminalized. */
  pendingFollowUps: number;
  /** Whether a terminal event has been emitted for this correlation. */
  terminalEmitted: boolean;
}

// ---------------------------------------------------------------------------
// CoreSupervisor creation options
// ---------------------------------------------------------------------------

export interface CoreSupervisorOptions {
  /** Validated config loaded from env. */
  config: CoreConfig;
  /** Injectable clock (defaults to Date.now). */
  now?: Clock;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Injectable child factory (defaults to the production omp spawn). */
  childFactory?: ChildFactoryFn;
  /** Injectable UUID factory (defaults to randomUUID). */
  uuid?: () => string;
}

// ---------------------------------------------------------------------------
// CoreSupervisor
// ---------------------------------------------------------------------------

export class CoreSupervisor {
  private readonly config: CoreConfig;
  private readonly now: Clock;
  private readonly fetchImpl: FetchImpl;
  private readonly uuid!: () => string;
  private readonly childFactory!: ChildFactoryFn;

  private readonly adapters!: AdapterRegistry;
  private readonly sessions!: SessionRegistry;
  private readonly idempotency!: IdempotencyStore;
  private readonly buffer!: IngestBuffer;
  private readonly pool!: PoolManager;

  /** Per-conversation active correlation, keyed by composite (adapterId, conversationKey). */
  private readonly active = new Map<string, ActiveCorrelation>();
  /** Serializes ingest decisions for each adapter-scoped conversation. */
  private readonly inboundChains = new Map<string, Promise<void>>();
  /** Serializes startup redelivery by conversation without impersonating a live turn. */
  private readonly recoveryChains = new Map<string, Promise<void>>();

  /** Children are wired once even when the pool reuses them across turns. */
  private readonly wiredChildren = new WeakSet<RpcChild>();

  private closed = false;
  private settleTimer: NodeJS.Timeout | undefined;
  private closePromise: Promise<void> | null = null;

  constructor(options: CoreSupervisorOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.uuid = options.uuid ?? (() => randomUUID());
    this.childFactory =
      options.childFactory ?? this.defaultChildFactory.bind(this);

    this.adapters = new AdapterRegistry(this.config.adapters);
    this.sessions = new SessionRegistry({ dbPath: this.config.sessionDbPath });
    this.idempotency = new IdempotencyStore({
      dbPath: this.config.idempotencyDbPath,
    });
    this.buffer = new IngestBuffer({
      engagementWindowMs: this.config.engagementWindowMs,
      quietPeriodMs: this.config.ambientQuietPeriodMs,
      now: this.now,
    });
    this.pool = new PoolManager({
      registry: this.sessions,
      factory: this.childFactory,
      maxChildren: this.config.maxChildren,
      idleTimeoutMs: this.config.idleTimeoutMs,
      logger: (event) => {
        console.error(`[pool] ${event.type}: ${event.message}`);
      },
    });

    // Held ambient backlogs need something to release them once a room falls
    // silent; arrivals alone cannot, since silence is the absence of one.
    if (this.config.ambientQuietPeriodMs > 0) {
      this.settleTimer = setInterval(() => {
        void this.flushSettled();
      }, this.config.ambientQuietPeriodMs);
      this.settleTimer.unref?.();
    }
  }

  /**
   * Recover pending outbound deliveries after a process restart. Correlations
   * sharing a conversation are replayed serially, and new inbound work waits
   * for that conversation's recovery chain before choosing an active turn.
   */
  async recoverPending(): Promise<void> {
    const recoverable = new Map<string, PendingOutboundCorrelation>();
    for (const item of listPendingOutboundCorrelations(
      this.config.outboxDbPath,
    )) {
      recoverable.set(
        JSON.stringify([item.adapterId, item.correlationId]),
        item,
      );
    }
    // The prepared hook intentionally saves the terminal response before the
    // outbox insert. Include those rows so startup repairs that crash window.
    for (const entry of this.idempotency.listSavedResponses()) {
      recoverable.set(JSON.stringify([entry.adapterId, entry.correlationId]), {
        adapterId: entry.adapterId,
        conversationKey: entry.conversationKey,
        correlationId: entry.correlationId,
      });
    }
    if (recoverable.size === 0) return;

    const recoverPromises: Promise<void>[] = [];
    for (const item of recoverable.values()) {
      const convKey = compositeKey(item.adapterId, item.conversationKey);
      const entries = this.idempotency.getEntriesByCorrelation(
        item.adapterId,
        item.correlationId,
      );
      if (entries.length === 0) continue;

      const previous = this.recoveryChains.get(convKey) ?? Promise.resolve();
      const recovery = previous
        .catch(() => {})
        .then(async () => {
          const messageIds = new Set(entries.map((entry) => entry.messageId));
          const emitter = this.createEmitterWithMessages(
            item.adapterId,
            item.conversationKey,
            item.correlationId,
            messageIds,
          );
          try {
            const terminal = entries.find(
              (entry) => entry.deliveryState === "saved" && entry.response,
            )?.response;
            if (terminal) {
              await emitter.redeliverDurable(terminal);
            } else {
              await emitter.resumePending();
            }
            await emitter.flush();
          } finally {
            emitter.close();
          }
        });
      let tracked: Promise<void>;
      tracked = recovery.finally(() => {
        if (this.recoveryChains.get(convKey) === tracked) {
          this.recoveryChains.delete(convKey);
        }
      });
      this.recoveryChains.set(convKey, tracked);
      recoverPromises.push(tracked);
    }

    await Promise.allSettled(recoverPromises);
  }

  // ---- public API ----

  /**
   * Process an inbound adapter message. Returns acceptance metadata for the
   * HTTP layer; throws {@link InboundConflictError} for a payload conflict.
   *
   * Authentication (unknown adapter / bad secret) and malformed-body
   * classification are the HTTP layer's responsibility; this method assumes
   * the caller has already authenticated and validated the message shape.
   *
   * The HTTP layer should respond as soon as this returns; the LLM turn and
   * final callback happen asynchronously.
   */
  async processInbound(
    adapterId: string,
    message: InboundMessage,
  ): Promise<InboundResult> {
    if (this.closed) throw new Error("CoreSupervisor is closed");
    const convKey = compositeKey(adapterId, message.conversationKey);
    const previous = this.inboundChains.get(convKey) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.processInboundSerial(adapterId, message));
    const settled = run.then(
      () => {},
      () => {},
    );
    this.inboundChains.set(convKey, settled);

    try {
      return await run;
    } finally {
      if (this.inboundChains.get(convKey) === settled) {
        this.inboundChains.delete(convKey);
      }
    }
  }

  /**
   * Process one inbound message after earlier work for the same conversation
   * has settled. This keeps correlation assignment and activation atomic.
   */
  private async processInboundSerial(
    adapterId: string,
    message: InboundMessage,
  ): Promise<InboundResult> {
    const recovery = this.recoveryChains.get(
      compositeKey(adapterId, message.conversationKey),
    );
    if (recovery) await recovery.catch(() => {});
    // An addressed message arriving mid-turn supersedes the turn in flight.
    //
    // This must happen BEFORE the correlation is read below: joining the
    // active correlation and then cancelling it would take the new message
    // down with the old turn, so the interruption would land but the
    // replacement would never be answered.
    const inFlight = this.active.get(
      compositeKey(adapterId, message.conversationKey),
    );
    if (inFlight && message.addressed && !inFlight.terminalEmitted) {
      await this.interruptTurn(inFlight);
    }

    // 1. Idempotency: new messages join the active turn correlation.
    const activeCorrelation = this.active.get(
      compositeKey(adapterId, message.conversationKey),
    );
    let beginResult;
    try {
      beginResult = this.idempotency.beginInbound(
        adapterId,
        message,
        activeCorrelation?.correlationId,
      );
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new InboundConflictError(adapterId, message.messageId);
      }
      throw err;
    }

    switch (beginResult.kind) {
      case "already-sent":
        return {
          kind: "duplicate",
          correlationId: beginResult.correlationId,
          status: "duplicate",
        };
      case "response-saved":
      case "delivery-failed":
        await this.redeliverSaved(adapterId, message, beginResult);
        return {
          kind: "duplicate",
          correlationId: beginResult.correlationId,
          status: "duplicate",
        };
      case "pending":
        // Duplicate pending: same message still in flight. Return duplicate
        // acceptance without another append/turn.
        if (
          !activeCorrelation &&
          this.idempotency.getEntry(adapterId, message.messageId)
            ?.ingestState === "pending"
        ) {
          this.terminalizeAcceptedInbound(
            adapterId,
            message,
            beginResult.correlationId,
          );
        }
        return {
          kind: "duplicate",
          correlationId: beginResult.correlationId,
          status: "duplicate",
        };
      case "created":
        // New correlation; proceed to ingest.
        break;
    }

    const correlationId = beginResult.correlationId;

    // 2. Ingest through the buffer for activation decision.
    const streaming = this.isStreaming(adapterId, message.conversationKey);
    const ingestResult = this.buffer.ingest(adapterId, message, streaming);

    if (ingestResult.kind === "buffered") {
      // Ambient outside engagement: append one passive agent-attributed
      // message without an LLM turn. The ambient extension command writes
      // the message into the OMP session with agent attribution.
      try {
        await this.appendPassiveMessage(adapterId, message, false);
      } catch (err) {
        console.error(
          `[ambient ingest] ${err instanceof Error ? err.message : String(err)}`,
        );
        this.terminalizeAcceptedInbound(adapterId, message, correlationId);
        return { kind: "accepted", correlationId, status: "accepted" };
      }
      this.idempotency.markIngestComplete(adapterId, message.messageId);
      return { kind: "accepted", correlationId, status: "accepted" };
    }

    // 3. Activation: acquire lease, start/steer/follow-up the child.
    try {
      await this.activate(adapterId, message, correlationId, ingestResult.mode);
    } catch (err) {
      console.error(
        `[activation] ${err instanceof Error ? err.message : String(err)}`,
      );
      this.terminalizeAcceptedInbound(adapterId, message, correlationId);
    }

    return { kind: "accepted", correlationId, status: "accepted" };
  }

  /**
   * Dismiss the engagement window for a conversation (DELETE endpoint).
   * Returns true if an active window was closed.
   */
  dismissEngagement(adapterId: string, conversationKey: string): boolean {
    return this.buffer.dismiss(adapterId, conversationKey);
  }

  /** Whether an adapter is registered. */
  hasAdapter(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  /** Authenticate an inbound request (constant-time). */
  authenticateInbound(adapterId: string, presentedSecret: string): boolean {
    if (!this.adapters.has(adapterId)) return false;
    return this.adapters.authenticateInbound(adapterId, presentedSecret);
  }

  // ---- lifecycle ----

  /** Close the supervisor: drain pool, close stores, close emitters. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  private async closeImpl(): Promise<void> {
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = undefined;
    }
    // Closing the pool first stops active children and rejects queued
    // acquisitions. Preserve its failure while still draining emitters and
    // closing durable stores.
    let poolError: unknown;
    try {
      await this.pool.close();
    } catch (error) {
      poolError = error;
    }

    // Any inbound work released by pool shutdown must finish its durable
    // terminal transition before the idempotency store is closed.
    await Promise.allSettled(this.inboundChains.values());
    await Promise.allSettled(this.recoveryChains.values());

    const emitterPromises: Promise<void>[] = [];
    for (const corr of this.active.values()) {
      emitterPromises.push(corr.emitter.flush());
    }
    await Promise.allSettled(emitterPromises);

    for (const corr of this.active.values()) {
      corr.emitter.close();
    }
    this.active.clear();
    this.idempotency.close();
    this.sessions.close();

    if (poolError) throw poolError;
  }

  /**
   * Start a turn for every conversation whose held ambient backlog has
   * settled.
   *
   * Each held message was already appended to its session when it was
   * buffered, so the context exists; what is missing is a turn over it. The
   * synthesized message carries the whole held span, which is what makes the
   * agent catch up on the conversation rather than answer its last line.
   *
   * Failures are logged and dropped: a settled flush is opportunistic, and a
   * conversation that cannot start one now will try again on the next sweep
   * or the next arrival.
   */
  private async flushSettled(): Promise<void> {
    if (this.closed) return;
    for (const settled of this.buffer.sweepSettled()) {
      const last = settled.records[settled.records.length - 1];
      const message: InboundMessage = {
        messageId: last.messageId,
        conversationKey: settled.conversationKey,
        speaker: last.speaker,
        text: settled.prompt,
        attachments: [],
        addressed: false,
      };
      try {
        const begun = this.idempotency.beginInbound(settled.adapterId, message);
        await this.activate(
          settled.adapterId,
          message,
          begun.correlationId,
          "prompt",
        );
      } catch (err) {
        console.error(
          `[settled flush] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---- internals: activation ----

  /**
   * Activate a turn: acquire a lease, ensure an OutboundEmitter, and
   * dispatch the prompt/steer/follow-up to the child.
   *
   * For addressed (prompt/steer): the current message is sent as a normal
   * RPC prompt. Previous passive records are already in the session history
   * (appended via the ambient extension); they are NOT duplicated into the
   * prompt text.
   *
   * For ambient follow-up: the message is appended as a passive
   * agent-attributed follow-up via the ambient extension with triggerTurn=true,
   * which triggers the turn inside OMP. No separate prompt is sent.
   */
  private async activate(
    adapterId: string,
    message: InboundMessage,
    correlationId: string,
    mode: ActivationMode,
  ): Promise<void> {
    // Commands core handles itself, before any child is leased.
    //
    // Session identity belongs to core, not to OMP: a conversation is bound to
    // a session file by the registry, so OMP's own /new cannot take effect —
    // it would report a fresh start while core handed the same session back on
    // the next turn. Handling it here drops the mapping instead, which is what
    // the user actually asked for.
    //
    // Only an exact match counts, so "what does /new do?" is a normal message.
    // /compact is deliberately NOT intercepted: it mutates the current session
    // in place, which already works through OMP.
    if (SESSION_RESET_COMMANDS[message.text.trim().toLowerCase()] === true) {
      await this.handleSessionReset(adapterId, message, correlationId);
      return;
    }

    const convKey = compositeKey(adapterId, message.conversationKey);
    let corr = this.active.get(convKey);
    // One live lease stays held for an active correlation until terminal
    // completion; later arrivals use that child directly, never re-acquire.
    if (!corr) {
      const lease = await this.pool.acquire(
        adapterId,
        message.conversationKey,
        message.parentConversationKey,
      );
      const messageIds = new Set([message.messageId]);
      const emitter = this.createEmitter(
        adapterId,
        message.conversationKey,
        correlationId,
        messageIds,
      );
      corr = {
        correlationId,
        adapterId,
        conversationKey: message.conversationKey,
        messageIds,
        emitter,
        lease,
        pendingFollowUps: 0,
        terminalEmitted: false,
      };
      this.active.set(convKey, corr);

      // Route this conversation's child once. Pool reuse must not accumulate
      // duplicate event listeners across successive correlations.
      this.wireChild(lease.child, adapterId, message.conversationKey);
    } else {
      // Active correlation: use the existing child directly.
      corr.messageIds.add(message.messageId);
    }

    // Reset engagement on agent interaction.
    this.buffer.recordInteraction(adapterId, message.conversationKey);

    const child = corr.lease!.child;

    try {
      if (mode === "prompt") {
        // Addressed, non-streaming: send the current message as a normal
        // RPC prompt. The backlog was already appended as passive messages;
        // they are in the session history and NOT duplicated in the prompt.
        const promptText = renderRecord({
          adapterId,
          conversationKey: message.conversationKey,
          messageId: message.messageId,
          speaker: message.speaker,
          text: message.text,
          attachments: message.attachments,
          addressed: message.addressed,
          receivedAt: this.now(),
        });
        const images = await this.loadImages(message.attachments);
        assertRpcSuccess(
          await child.prompt(promptText, images.length ? { images } : {}),
          "prompt",
        );
      } else if (mode === "steer") {
        // Addressed, streaming: steer the active stream with the current
        // message. Backlog is in the session history, not duplicated.
        const promptText = renderRecord({
          adapterId,
          conversationKey: message.conversationKey,
          messageId: message.messageId,
          speaker: message.speaker,
          text: message.text,
          attachments: message.attachments,
          addressed: message.addressed,
          receivedAt: this.now(),
        });
        const images = await this.loadImages(message.attachments);
        assertRpcSuccess(
          await child.prompt(promptText, {
            streamingBehavior: "steer",
            ...(images.length ? { images } : {}),
          }),
          "steer",
        );
      } else {
        // mode === "followUp": ambient inside the engagement window. Append
        // the message as a passive agent-attributed follow-up via the ambient
        // extension with triggerTurn=true. The extension triggers the turn
        // inside OMP; no separate prompt command is needed.
        corr.pendingFollowUps++;
        await this.runAmbientCommand(child, adapterId, message, true);
      }
    } catch (error) {
      if (mode === "followUp" && corr.pendingFollowUps > 0) {
        corr.pendingFollowUps--;
      }
      void this.pool
        .retireChild(adapterId, message.conversationKey, child)
        .catch((closeError: unknown) => {
          console.error(
            `[rpc child close] ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          );
        });
      throw error;
    }

    // A terminal event may have completed ingest before the prompt ack arrived.
    if (
      this.idempotency.getEntry(adapterId, message.messageId)?.ingestState ===
      "pending"
    ) {
      this.idempotency.markIngestComplete(adapterId, message.messageId);
    }
  }

  /**
   * Read image attachments into inline content the model can actually look at.
   *
   * Attachments are otherwise only named in the prompt text, which tells a
   * vision model a file exists without letting it see the contents; the agent
   * ends up reporting that it has the filename but cannot open the image.
   *
   * Non-image attachments keep their path-only treatment: the agent can open
   * those with normal file tools. A file that cannot be read is skipped rather
   * than failing the turn, since the message itself is still answerable.
   */
  private async loadImages(
    attachments: InboundMessage["attachments"],
  ): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of attachments) {
      const mimeType = attachment.mediaType;
      if (!mimeType?.startsWith("image/")) continue;
      // Same root the child is spawned with (resolveChildSpawnPlan), so a
      // workspace-relative path means the same thing here and to the agent.
      const root = this.config.agentRootDir;
      const absolute =
        isAbsolute(attachment.path) || root === null
          ? attachment.path
          : join(root, "workspace", attachment.path);
      try {
        const bytes = await readFile(absolute);
        await this.retainImageBlob(bytes);
        images.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType,
        });
      } catch (error) {
        console.error(
          `[attachment] could not read image ${absolute}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return images;
  }

  /**
   * Keep a copy of an inline image under the agent's blob store.
   *
   * OMP records an image in session history as a `blob:sha256:<digest>`
   * reference rather than inline base64, and resolves it from the blob store
   * when replaying that history to the model. The blob store lives in the
   * agent's ephemeral home while attachments live on the durable volume, so a
   * rebuild leaves history pointing at bytes that no longer exist and every
   * later turn in that conversation fails to build a model request.
   *
   * Writing the blob here, keyed by the same digest OMP derives, makes the
   * durable attachment the source of truth for its own history reference.
   * Failure is not fatal: the current turn already carries the image inline.
   */
  private async retainImageBlob(bytes: Buffer): Promise<void> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    // $HOME/.omp/agent is OMP's default agent directory, which the child
    // inherits; the bundle installs the agent definition there precisely so
    // every OMP discovery surface shares one root.
    const blobPath = join(homedir(), ".omp", "agent", "blobs", digest);
    try {
      await mkdir(dirname(blobPath), { recursive: true });
      await writeFile(blobPath, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      console.error(
        `[attachment] could not retain image blob ${digest}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Start a new session for a conversation. Drops the registry mapping so the
   * next message creates a fresh session; the previous session file stays on
   * disk, so its history remains recoverable.
   */
  private async handleSessionReset(
    adapterId: string,
    message: InboundMessage,
    correlationId: string,
  ): Promise<void> {
    const convKey = compositeKey(adapterId, message.conversationKey);
    const existed = this.sessions.forget(adapterId, message.conversationKey);
    this.buffer.recordInteraction(adapterId, message.conversationKey);

    // Register a correlation exactly like a real turn so the terminal reply
    // flows through the normal completion path. Emitting and closing by hand
    // skipped the flush, which left the event undelivered and the conversation
    // wedged with no lease and no terminal event.
    const corr: ActiveCorrelation = {
      correlationId,
      adapterId,
      conversationKey: message.conversationKey,
      messageIds: new Set([message.messageId]),
      emitter: this.createEmitter(
        adapterId,
        message.conversationKey,
        correlationId,
        new Set([message.messageId]),
      ),
      lease: null,
      pendingFollowUps: 0,
      terminalEmitted: false,
    };
    this.active.set(convKey, corr);
    corr.emitter.emitDirectReply(
      existed
        ? "Started a new session. Earlier messages are no longer in context."
        : "Already on a new session.",
    );
    corr.terminalEmitted = true;
    this.cleanupCorrelation(convKey, corr);
  }

  /**
   * Abandon an in-flight turn because a newer addressed message superseded it.
   *
   * Aborts the child so it stops generating, emits the terminal cancellation
   * so the adapter can remove any partial output it already posted, and clears
   * the correlation. The replacement turn then leases the child normally.
   *
   * Best-effort by design: a failed abort must not stop the newer message
   * being answered, which is the whole point of interrupting.
   */
  private async interruptTurn(corr: ActiveCorrelation): Promise<void> {
    const convKey = compositeKey(corr.adapterId, corr.conversationKey);
    // Emit the cancellation BEFORE aborting. Aborting makes the child report
    // agent_end with no text, which the emitter would otherwise turn into an
    // "Agent completed without producing a reply" error posted to the channel.
    // Claiming the terminal first makes that path a no-op.
    corr.emitter.emitCancelled();
    corr.terminalEmitted = true;
    if (corr.lease) {
      try {
        await corr.lease.child.abort();
      } catch {
        // Child already gone or unresponsive; the cleanup below still runs.
      }
    }
    this.cleanupCorrelation(convKey, corr);
  }

  // ---- internals: passive message append ----

  /**
   * Append a passive agent-attributed message to the OMP session via the
   * ambient ingest extension command. When triggerTurn is false, the message
   * is persisted with agent attribution but no LLM turn is started. When
   * triggerTurn is true, the extension triggers a follow-up turn.
   */
  private async appendPassiveMessage(
    adapterId: string,
    message: InboundMessage,
    triggerTurn: boolean,
  ): Promise<void> {
    const convKey = compositeKey(adapterId, message.conversationKey);
    const corr = this.active.get(convKey);
    if (corr && corr.lease) {
      await this.runAmbientCommand(
        corr.lease.child,
        adapterId,
        message,
        triggerTurn,
      );
      return;
    }
    // No active child: acquire a lease just for the append, then release.
    const lease = await this.pool.acquire(
      adapterId,
      message.conversationKey,
      message.parentConversationKey,
    );
    try {
      await this.runAmbientCommand(
        lease.child,
        adapterId,
        message,
        triggerTurn,
      );
    } catch (error) {
      void this.pool
        .retireChild(adapterId, message.conversationKey, lease.child)
        .catch(() => {});
      throw error;
    } finally {
      lease.release();
    }
  }

  /**
   * Run the ambient ingest extension command on a child with the message
   * encoded as base64url JSON.
   */
  private async runAmbientCommand(
    child: RpcChild,
    adapterId: string,
    message: InboundMessage,
    triggerTurn: boolean,
  ): Promise<void> {
    const content = renderRecord({
      adapterId,
      conversationKey: message.conversationKey,
      messageId: message.messageId,
      speaker: message.speaker,
      text: message.text,
      attachments: message.attachments,
      addressed: message.addressed,
      receivedAt: this.now(),
    });
    const payload = JSON.stringify({ content, triggerTurn });
    const encoded = Buffer.from(payload, "utf8").toString("base64url");
    const response = await child.prompt(
      `/${AMBIENT_INGEST_COMMAND} ${encoded}`,
    );
    assertRpcSuccess(response, "ambient ingest");
  }

  // ---- internals: child event routing ----

  /** Attach stable routing and fatal-process handlers once per pooled child. */
  private wireChild(
    child: RpcChild,
    adapterId: string,
    conversationKey: string,
  ): void {
    if (this.wiredChildren.has(child)) return;
    this.wiredChildren.add(child);
    const convKey = compositeKey(adapterId, conversationKey);

    child.onEvent((frame: RpcEventFrame) => {
      this.handleChildEvent(convKey, frame);
    });
    child.on("error", (error: Error) => {
      console.error(`[rpc child] ${error.message}`);
      void this.pool
        .retireChild(adapterId, conversationKey, child)
        .catch((closeError: unknown) => {
          console.error(
            `[rpc child close] ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          );
        });
      this.failCorrelation(convKey);
    });
    child.on("exit", () => {
      if (!this.closed) {
        this.pool.forgetExitedChild(adapterId, conversationKey, child);
      }
      this.failCorrelation(convKey);
    });
  }

  /** Convert an unexpected child failure into one durable, curated terminal. */
  private failCorrelation(convKey: string): void {
    const corr = this.active.get(convKey);
    if (!corr || corr.terminalEmitted) return;
    corr.terminalEmitted = true;
    corr.emitter.emitPresence("offline");
    corr.emitter.emitProviderError({
      code: "agent_unavailable",
      message: "Agent process stopped before completing the turn",
      retryable: true,
    });
    this.cleanupCorrelation(convKey, corr);
  }

  /**
   * Route a child event frame to the active correlation's OutboundEmitter.
   * The emitter maps frames to versioned OutboundEvents and handles all
   * sequencing and delivery.
   */
  private handleChildEvent(convKey: string, frame: RpcEventFrame): void {
    const corr = this.active.get(convKey);
    if (!corr) return;

    // A queued ambient follow-up starts another agent turn. Suppress the
    // preceding agent_end so the emitter produces one terminal event only
    // after the final queued turn.
    if (frame.type === "agent_end" && corr.pendingFollowUps > 0) {
      corr.pendingFollowUps--;
      return;
    }

    if (frame.type === "turn_start") {
      corr.emitter.ingest(frame);
      corr.emitter.emitPresence("active");
      this.buffer.recordInteraction(corr.adapterId, corr.conversationKey);
      return;
    }
    if (frame.type === "agent_end") {
      corr.emitter.emitPresence("idle");
    }

    // Route the frame to the emitter for versioned event mapping.
    corr.emitter.ingest(frame);

    if (frame.type === "agent_end") {
      this.handleAgentEnd(convKey, corr);
    }

    // Reset engagement while the assistant is producing output so late-arriving
    // ambient messages stay inside the window.
    if (frame.type === "message_update") {
      this.buffer.recordInteraction(corr.adapterId, corr.conversationKey);
    }
  }

  /**
   * Handle agent_end: if no queued follow-ups remain, terminalize the
   * correlation. The emitter emits the terminal turn.reply; the durable
   * hooks save/deliver across every message id in the group.
   */
  private handleAgentEnd(convKey: string, corr: ActiveCorrelation): void {
    if (corr.terminalEmitted) return;
    corr.terminalEmitted = true;

    // The emitter's handleAgentEnd emits the terminal turn.reply. The
    // durable hooks (onDurablePrepared/onDurableDelivered/onDurableFailed)
    // handle save/mark across all message ids in the group.

    // Flush the emitter to ensure the terminal event is persisted and
    // delivery is attempted before we release the lease.
    this.cleanupCorrelation(convKey, corr);
  }

  /**
   * Clean up a terminalized correlation: release the lease and remove
   * the active state. The emitter is flushed and closed.
   */
  private cleanupCorrelation(convKey: string, corr: ActiveCorrelation): void {
    if (this.active.get(convKey) === corr) {
      this.active.delete(convKey);
    }
    if (corr.lease) {
      corr.lease.release();
      corr.lease = null;
    }
    corr.emitter
      .flush()
      .then(() => {
        corr.emitter.close();
      })
      .catch(() => {
        corr.emitter.close();
      });
  }

  // ---- internals: redelivery ----

  /**
   * Redeliver a saved/failed terminal response through the emitter without
   * another agent turn. The emitter's resumePending re-drives pending rows.
   */
  private async redeliverSaved(
    adapterId: string,
    message: InboundMessage,
    beginResult:
      | {
          kind: "response-saved";
          correlationId: string;
          response: OutboundEvent;
        }
      | {
          kind: "delivery-failed";
          correlationId: string;
          response: OutboundEvent;
          error: string;
        },
  ): Promise<void> {
    const convKey = compositeKey(adapterId, message.conversationKey);
    let corr = this.active.get(convKey);
    if (!corr) {
      const entries = this.idempotency.getEntriesByCorrelation(
        adapterId,
        beginResult.correlationId,
      );
      const messageIds = new Set(entries.map((entry) => entry.messageId));
      const emitter = this.createEmitter(
        adapterId,
        message.conversationKey,
        beginResult.correlationId,
        messageIds,
      );
      corr = {
        correlationId: beginResult.correlationId,
        adapterId,
        conversationKey: message.conversationKey,
        messageIds,
        emitter,
        lease: null,
        pendingFollowUps: 0,
        terminalEmitted: true,
      };
      this.active.set(convKey, corr);
    }
    for (const entry of this.idempotency.getEntriesByCorrelation(
      adapterId,
      beginResult.correlationId,
    )) {
      corr.messageIds.add(entry.messageId);
    }

    await corr.emitter.redeliverDurable(beginResult.response);
    await corr.emitter.flush();

    // If this was a transient redelivery correlation with no lease, clean up.
    if (!corr.lease) {
      corr.emitter.close();
      if (this.active.get(convKey) === corr) {
        this.active.delete(convKey);
      }
    }
  }

  // ---- internals: emitter creation ----

  /**
   * Create an OutboundEmitter whose durable hooks resolve every persisted
   * inbound row in the correlation at hook time.
   */
  private createEmitter(
    adapterId: string,
    conversationKey: string,
    correlationId: string,
    messageIds: Set<string>,
  ): OutboundEmitter {
    return this.createEmitterWithMessages(
      adapterId,
      conversationKey,
      correlationId,
      messageIds,
    );
  }

  /** Create an emitter with the message-id set used by durable hooks. */
  private createEmitterWithMessages(
    adapterId: string,
    conversationKey: string,
    correlationId: string,
    messageIds: Set<string>,
  ): OutboundEmitter {
    const resolveEntries = (): IdempotencyEntry[] => {
      const entries = this.idempotency.getEntriesByCorrelation(
        adapterId,
        correlationId,
      );
      for (const entry of entries) messageIds.add(entry.messageId);
      return entries;
    };

    return new OutboundEmitter({
      adapterId,
      conversationKey,
      correlationId,
      resolveAdapterTarget: (id) => this.resolveAdapterTarget(id),
      fetchImpl: this.fetchImpl,
      dbPath: this.config.outboxDbPath,
      progressThresholdMs: this.config.progressThresholdMs,
      retryDelaysMs: this.config.retryDelaysMs,
      requestTimeoutMs: this.config.callbackTimeoutMs,
      now: this.now,
      uuid: this.uuid,
      logger: {
        warn: (msg, extra) =>
          console.error(`[emitter warn] ${msg}`, extra ?? {}),
        error: (msg, extra) =>
          console.error(`[emitter error] ${msg}`, extra ?? {}),
      },
      hooks: {
        onDurablePrepared: (event: OutboundEvent): void => {
          if (event.type !== "turn.reply" && event.type !== "turn.error")
            return;
          resolveEntries();
          this.idempotency.saveResponseForCorrelation(
            adapterId,
            correlationId,
            event,
          );
        },
        onDurableDelivered: (event: OutboundEvent): void => {
          if (event.type !== "turn.reply" && event.type !== "turn.error")
            return;
          resolveEntries();
          this.idempotency.markCorrelationSent(
            adapterId,
            correlationId,
            event.eventId,
          );
        },
        onDurableFailed: (event: OutboundEvent, error: string): void => {
          if (event.type !== "turn.reply" && event.type !== "turn.error")
            return;
          resolveEntries();
          this.idempotency.markCorrelationFailed(
            adapterId,
            correlationId,
            event.eventId,
            error,
          );
        },
      },
    });
  }

  /**
   * Convert a post-reservation ingest failure into a durable terminal callback.
   * The terminal save also completes any row whose prompt acknowledgement was
   * overtaken by child events.
   */
  private terminalizeAcceptedInbound(
    adapterId: string,
    message: InboundMessage,
    correlationId: string,
  ): void {
    if (this.idempotency.getEntry(adapterId, message.messageId)?.response)
      return;
    const convKey = compositeKey(adapterId, message.conversationKey);
    let corr = this.active.get(convKey);
    if (!corr) {
      const entries = this.idempotency.getEntriesByCorrelation(
        adapterId,
        correlationId,
      );
      const messageIds = new Set(entries.map((entry) => entry.messageId));
      const emitter = this.createEmitter(
        adapterId,
        message.conversationKey,
        correlationId,
        messageIds,
      );
      corr = {
        correlationId,
        adapterId,
        conversationKey: message.conversationKey,
        messageIds,
        emitter,
        lease: null,
        pendingFollowUps: 0,
        terminalEmitted: false,
      };
      this.active.set(convKey, corr);
    }
    if (corr.terminalEmitted) return;
    corr.messageIds.add(message.messageId);
    corr.terminalEmitted = true;
    corr.emitter.emitProviderError({
      code: "agent_unavailable",
      message: "Agent process could not accept the message",
      retryable: true,
    });
    this.cleanupCorrelation(convKey, corr);
  }

  /**
   * Resolve the adapter callback target (URL + signing closure). The secret
   * never leaves the adapter registry; the sign closure captures it.
   */
  private resolveAdapterTarget(adapterId: string): AdapterTarget | null {
    if (!this.adapters.has(adapterId)) return null;
    const callbackUrl = this.adapters.getCallbackUrl(adapterId);
    const sign = (body: string): string =>
      this.adapters.signOutbound(adapterId, body);
    return { callbackUrl, sign };
  }

  // ---- internals: child factory ----

  /**
   * Default child factory: spawn `omp --mode rpc` with the ambient ingest
   * extension, the configured workspace as cwd, optional model/profile,
   * and extra args. Negotiate protocol v2 after start.
   */
  private async defaultChildFactory(ctx: {
    adapterId: string;
    conversationKey: string;
    registryKey: string;
  }): Promise<RpcChild> {
    const extensionPath = this.resolveAmbientExtensionPath();
    const registration = this.adapters.get(ctx.adapterId);
    const plan = resolveChildSpawnPlan(this.config, registration);
    const args: string[] = ["--mode", "rpc"];
    // Load the production ambient extension explicitly. OMP_AGENT_DIR
    // points OMP at the ephemeral copy of the bundled definition, preserving
    // config, tools, skills, commands, extensions, and subagents.
    args.push("-e", extensionPath);
    if (plan.model) {
      args.push("--model", plan.model);
    }
    if (this.config.ompProfile) {
      args.push("--profile", this.config.ompProfile);
    }
    args.push("--cwd", plan.cwd);
    args.push(...plan.args);

    mkdirSync(plan.cwd, { recursive: true });

    const child = new RpcChild({
      binary: this.config.ompBinary,
      args,
      cwd: plan.cwd,
      registryPath: this.config.childRegistryPath || undefined,
      conversationKey: ctx.registryKey,
    });
    this.wireChild(child, ctx.adapterId, ctx.conversationKey);
    await child.start();
    // Negotiate protocol v2 for server-side outbound chunking.
    await child.negotiateProtocolV2();
    return child;
  }

  /**
   * Resolve the filesystem path to the ambient-ingest-extension.ts file.
   * In production it is at /app/packages/core/src/ambient-ingest-extension.ts;
   * in development/tests it is resolved relative to this module.
   */
  private resolveAmbientExtensionPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "ambient-ingest-extension.ts");
  }

  // ---- internals: helpers ----

  /**
   * Check whether the conversation has an active correlation (a turn is
   * in flight). When true, the IngestBuffer selects streaming modes
   * (steer/followUp) for activation.
   */
  private isStreaming(adapterId: string, conversationKey: string): boolean {
    const corr = this.active.get(compositeKey(adapterId, conversationKey));
    return corr !== undefined && corr.lease !== null;
  }
}

// ---------------------------------------------------------------------------
// Creation API for tests and boot
// ---------------------------------------------------------------------------

/**
 * Create a CoreSupervisor from a config and optional injectables. This is
 * the entry point for both the executable boot path and focused smoke tests.
 */
export function createCoreSupervisor(
  options: CoreSupervisorOptions,
): CoreSupervisor {
  return new CoreSupervisor(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Require an affirmative RPC response before acknowledging ingest. */
function assertRpcSuccess(response: RpcResponseFrame, operation: string): void {
  if (!response.success) {
    throw new Error(`${operation} was rejected by the agent process`);
  }
}

/**
 * Messages core answers itself by starting a new session. Matched against the
 * whole trimmed, lowercased message so a mention of the command in ordinary
 * conversation is not treated as one.
 */
const SESSION_RESET_COMMANDS: Record<string, true> = {
  "/new": true,
  "/reset": true,
};

/** Composite conversation key (collision-proof, same algorithm as IngestBuffer). */
function compositeKey(adapterId: string, conversationKey: string): string {
  return `${adapterId.length}:${adapterId}${conversationKey}`;
}

// ---------------------------------------------------------------------------
// Per-agent child spawn planning
// ---------------------------------------------------------------------------

/** Resolved spawn inputs for a child process: cwd, model, and args. */
export interface ChildSpawnPlan {
  cwd: string;
  model: string | null;
  args: string[];
}

/**
 * Resolve the cwd, model, and args for one agent-bound adapter.
 *
 * Production registrations are required to carry the configured singular
 * agent id. Missing or mismatched identity fails loudly; child processes
 * never fall back to the legacy shared workspace.
 */
export function resolveChildSpawnPlan(
  config: CoreConfig,
  registration: AdapterRegistration | undefined,
): ChildSpawnPlan {
  if (registration === undefined) {
    throw new Error("cannot spawn a child without an adapter registration");
  }
  if (registration.agentId === undefined) {
    throw new Error(`adapter "${registration.adapterId}" is not bound to OMP_AGENT_ID`);
  }
  if (config.agentRootDir === null) {
    throw new Error(
      `adapter "${registration.adapterId}" is bound to agent "${registration.agentId}" but OMP_AGENT_ROOT is not set`,
    );
  }
  if (config.agentId === null) {
    throw new Error(
      `adapter "${registration.adapterId}" is bound to agent "${registration.agentId}" but OMP_AGENT_ID is not set`,
    );
  }
  if (registration.agentId !== config.agentId) {
    throw new Error(
      `adapter "${registration.adapterId}" is bound to agent "${registration.agentId}" but OMP_AGENT_ID is "${config.agentId}"`,
    );
  }
  return {
    cwd: join(config.agentRootDir, "workspace"),
    model: config.ompModel,
    args: config.ompArgs,
  };
}
