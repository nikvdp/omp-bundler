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
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { InboundMessage } from "@omp-bundler/contracts/inbound";
import type { OutboundEvent } from "@omp-bundler/contracts/outbound";

import { AdapterRegistry } from "./adapter-registry.js";
import { SessionRegistry } from "./session-registry.js";
import {
  IdempotencyStore,
  IdempotencyConflictError,
  type IdempotencyEntry,
} from "./idempotency-store.js";
import { IngestBuffer, type ActivationMode, renderRecord } from "./ingest-buffer.js";
import { PoolManager, type ChildFactory, type Lease } from "./pool-manager.js";
import { RpcChild, type RpcEventFrame } from "./rpc-child.js";
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
    super(`idempotency conflict for adapter="${adapterId}" message="${messageId}"`);
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
  private readonly uuid: () => string;
  private readonly childFactory: ChildFactoryFn;

  private readonly adapters: AdapterRegistry;
  private readonly sessions: SessionRegistry;
  private readonly idempotency: IdempotencyStore;
  private readonly buffer: IngestBuffer;
  private readonly pool: PoolManager;

  /** Per-conversation active correlation, keyed by composite (adapterId, conversationKey). */
  private readonly active = new Map<string, ActiveCorrelation>();

  private closed = false;

  constructor(options: CoreSupervisorOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.buffer = new IngestBuffer({
      engagementWindowMs: this.config.engagementWindowMs,
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
  }

  /**
   * Recover pending outbound deliveries after a process restart. For each
   * pending outbox correlation, instantiate an emitter with durable hooks
   * wired over the correlation's message ids (from the idempotency store)
   * and call resumePending(). No model turn is replayed; only undelivered
   * HTTP POSTs are re-driven.
   *
   * Safe to call once at startup. Idempotent: correlations already in the
   * active map are skipped.
   */
  async recoverPending(): Promise<void> {
    const pending: PendingOutboundCorrelation[] = listPendingOutboundCorrelations(
      this.config.outboxDbPath,
    );
    if (pending.length === 0) return;

    const recoverPromises: Promise<void>[] = [];
    for (const p of pending) {
      const convKey = compositeKey(p.adapterId, p.conversationKey);
      if (this.active.has(convKey)) continue;

      // Look up all message ids in this correlation from the idempotency store.
      const entries: IdempotencyEntry[] = this.idempotency.getEntriesByCorrelation(
        p.adapterId,
        p.correlationId,
      );
      if (entries.length === 0) continue;

      const messageIds = new Set(entries.map((e) => e.messageId));
      const emitter = this.createEmitterWithMessages(
        p.adapterId,
        p.conversationKey,
        p.correlationId,
        messageIds,
      );

      // Track as a terminal correlation (no lease, no child events).
      const corr: ActiveCorrelation = {
        correlationId: p.correlationId,
        adapterId: p.adapterId,
        conversationKey: p.conversationKey,
        messageIds,
        emitter,
        lease: null,
        pendingFollowUps: 0,
        terminalEmitted: true,
      };
      this.active.set(convKey, corr);

      recoverPromises.push(
        emitter.resumePending().then(() => emitter.flush()).then(() => {
          // Clean up the transient recovery correlation once delivery settles.
          const c = this.active.get(convKey);
          if (c && !c.lease) {
            c.emitter.close();
            this.active.delete(convKey);
          }
        }),
      );
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
  async processInbound(adapterId: string, message: InboundMessage): Promise<InboundResult> {
    // 1. Idempotency: begin or classify.
    let beginResult;
    try {
      beginResult = this.idempotency.beginInbound(adapterId, message);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new InboundConflictError(adapterId, message.messageId);
      }
      throw err;
    }

    switch (beginResult.kind) {
      case "already-sent":
        return { kind: "duplicate", correlationId: beginResult.correlationId, status: "duplicate" };
      case "response-saved":
      case "delivery-failed":
        // Redeliver the saved terminal response through the emitter without
        // another agent turn.
        await this.redeliverSaved(adapterId, message, beginResult);
        return { kind: "duplicate", correlationId: beginResult.correlationId, status: "duplicate" };
      case "pending":
        // Duplicate pending: same message still in flight. Return duplicate
        // acceptance without another append/turn.
        return { kind: "duplicate", correlationId: beginResult.correlationId, status: "duplicate" };
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
        // Passive append failed before the message was persisted. Discard
        // the pending idempotency row so a retry can reprocess.
        this.discardPending(adapterId, message.messageId);
        throw err;
      }
      this.idempotency.markIngestComplete(adapterId, message.messageId);
      return { kind: "accepted", correlationId, status: "accepted" };
    }

    // 3. Activation: acquire lease, start/steer/follow-up the child.
    try {
      await this.activate(adapterId, message, correlationId, ingestResult.mode);
    } catch (err) {
      // Activation failed before the RPC prompt was acknowledged. Discard
      // the pending idempotency row so a retry can reprocess.
      this.discardPending(adapterId, message.messageId);
      throw err;
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
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Flush and close all active emitters.
    const emitterPromises: Promise<void>[] = [];
    for (const corr of this.active.values()) {
      emitterPromises.push(corr.emitter.flush().catch(() => {}));
    }
    await Promise.allSettled(emitterPromises);

    for (const corr of this.active.values()) {
      corr.emitter.close();
    }
    this.active.clear();

    // Close the pool (drains all children).
    try {
      await this.pool.close();
    } catch {
      // Pool close errors are surfaced but do not block store cleanup.
    }

    // Close stores.
    this.idempotency.close();
    this.sessions.close();
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
    const convKey = compositeKey(adapterId, message.conversationKey);
    let corr = this.active.get(convKey);

    // One live lease stays held for an active correlation until terminal
    // completion; later arrivals use that child directly, never re-acquire.
    if (!corr) {
      const lease = await this.pool.acquire(adapterId, message.conversationKey);
      const emitter = this.createEmitter(adapterId, message.conversationKey, correlationId);
      corr = {
        correlationId,
        adapterId,
        conversationKey: message.conversationKey,
        messageIds: new Set([message.messageId]),
        emitter,
        lease,
        pendingFollowUps: 0,
        terminalEmitted: false,
      };
      this.active.set(convKey, corr);

      // Wire the child event handler to route frames to the emitter.
      lease.child.onEvent((frame: RpcEventFrame) => {
        this.handleChildEvent(convKey, frame);
      });
    } else {
      // Active correlation: use the existing child directly.
      corr.messageIds.add(message.messageId);
    }

    // Reset engagement on agent interaction.
    this.buffer.recordInteraction(adapterId, message.conversationKey);

    const child = corr.lease!.child;

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
      await child.prompt(promptText);
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
      await child.prompt(promptText, { streamingBehavior: "steer" });
    } else {
      // mode === "followUp": ambient inside the engagement window. Append
      // the message as a passive agent-attributed follow-up via the ambient
      // extension with triggerTurn=true. The extension triggers the turn
      // inside OMP; no separate prompt command is needed.
      corr.pendingFollowUps++;
      await this.runAmbientCommand(child, message, true);
    }

    // Mark ingest complete for this message (the turn has been dispatched).
    this.idempotency.markIngestComplete(adapterId, message.messageId);
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
      await this.runAmbientCommand(corr.lease.child, message, triggerTurn);
      return;
    }
    // No active child: acquire a lease just for the append, then release.
    const lease = await this.pool.acquire(adapterId, message.conversationKey);
    try {
      await this.runAmbientCommand(lease.child, message, triggerTurn);
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
    message: InboundMessage,
    triggerTurn: boolean,
  ): Promise<void> {
    const content = renderRecord({
      adapterId: "",
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
    await child.send({ type: "command", command: AMBIENT_INGEST_COMMAND, args: encoded });
  }

  // ---- internals: child event routing ----

  /**
   * Route a child event frame to the active correlation's OutboundEmitter.
   * The emitter maps frames to versioned OutboundEvents and handles all
   * sequencing and delivery.
   */
  private handleChildEvent(convKey: string, frame: RpcEventFrame): void {
    const corr = this.active.get(convKey);
    if (!corr) return;

    // Route the frame to the emitter for versioned event mapping.
    corr.emitter.ingest(frame);

    // Check for terminal (agent_end) to clean up the correlation.
    if (frame.type === "agent_end") {
      this.handleAgentEnd(convKey, corr);
    }

    // Reset engagement on agent interaction events (turn_start, message_update,
    // etc.) so late-arriving ambient messages stay inside the window.
    if (frame.type === "turn_start" || frame.type === "message_update") {
      this.buffer.recordInteraction(corr.adapterId, corr.conversationKey);
    }
  }

  /**
   * Handle agent_end: if no queued follow-ups remain, terminalize the
   * correlation. The emitter emits the terminal turn.reply; the durable
   * hooks save/deliver across every message id in the group.
   */
  private handleAgentEnd(convKey: string, corr: ActiveCorrelation): void {
    if (corr.pendingFollowUps > 0) {
      // A queued ambient follow-up is still in flight; do not close yet.
      corr.pendingFollowUps--;
      return;
    }

    if (corr.terminalEmitted) return;
    corr.terminalEmitted = true;

    // The emitter's handleAgentEnd emits the terminal turn.reply. The
    // durable hooks (onDurablePrepared/onDurableDelivered/onDurableFailed)
    // handle save/mark across all message ids in the group.

    // Flush the emitter to ensure the terminal event is persisted and
    // delivery is attempted before we release the lease.
    corr.emitter.flush().then(() => {
      this.cleanupCorrelation(convKey, corr);
    }).catch(() => {
      this.cleanupCorrelation(convKey, corr);
    });
  }

  /**
   * Clean up a terminalized correlation: release the lease and remove
   * the active state. The emitter is flushed and closed.
   */
  private cleanupCorrelation(convKey: string, corr: ActiveCorrelation): void {
    if (corr.lease) {
      corr.lease.release();
      corr.lease = null;
    }
    corr.emitter.flush().then(() => {
      corr.emitter.close();
    }).catch(() => {
      corr.emitter.close();
    });
    this.active.delete(convKey);
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
      | { kind: "response-saved"; correlationId: string; response: OutboundEvent }
      | { kind: "delivery-failed"; correlationId: string; response: OutboundEvent; error: string },
  ): Promise<void> {
    const convKey = compositeKey(adapterId, message.conversationKey);
    let corr = this.active.get(convKey);
    if (!corr) {
      // Create a transient emitter just for redelivery.
      const emitter = this.createEmitter(adapterId, message.conversationKey, beginResult.correlationId);
      corr = {
        correlationId: beginResult.correlationId,
        adapterId,
        conversationKey: message.conversationKey,
        messageIds: new Set([message.messageId]),
        emitter,
        lease: null,
        pendingFollowUps: 0,
        terminalEmitted: true,
      };
      this.active.set(convKey, corr);
    }

    // Resume any pending durable events for this correlation.
    await corr.emitter.resumePending();
    await corr.emitter.flush();

    // If this was a transient redelivery correlation with no lease, clean up.
    if (!corr.lease) {
      corr.emitter.close();
      this.active.delete(convKey);
    }
  }

  // ---- internals: emitter creation ----

  /**
   * Create an OutboundEmitter for a correlation with durable lifecycle hooks
   * wired to the idempotency store. The hooks save/mark failure/sent across
   * every message id in the correlation group. When `messageIds` is provided
   * (restart recovery), the hooks use that set directly; otherwise they
   * look up the active correlation to find the current message-id set.
   */
  private createEmitter(
    adapterId: string,
    conversationKey: string,
    correlationId: string,
  ): OutboundEmitter {
    return this.createEmitterWithMessages(
      adapterId,
      conversationKey,
      correlationId,
      null,
    );
  }

  /**
   * Create an OutboundEmitter with an explicit message-id set for restart
   * recovery. When `fixedMessageIds` is null, the hooks resolve the current
   * set from the active map (live correlation). When non-null, the hooks use
   * the fixed set directly (recovery correlation with no active state).
   */
  private createEmitterWithMessages(
    adapterId: string,
    conversationKey: string,
    correlationId: string,
    fixedMessageIds: Set<string> | null,
  ): OutboundEmitter {
    const convKey = compositeKey(adapterId, conversationKey);
    const supervisor = this;

    const resolveMessageIds = (): Set<string> => {
      if (fixedMessageIds) return fixedMessageIds;
      const corr = supervisor.active.get(convKey);
      return corr ? corr.messageIds : new Set();
    };

    return new OutboundEmitter({
      adapterId,
      conversationKey,
      correlationId,
      resolveAdapterTarget: (id) => supervisor.resolveAdapterTarget(id),
      fetchImpl: this.fetchImpl,
      dbPath: this.config.outboxDbPath,
      progressThresholdMs: this.config.progressThresholdMs,
      retryDelaysMs: this.config.retryDelaysMs,
      requestTimeoutMs: this.config.callbackTimeoutMs,
      now: this.now,
      uuid: this.uuid,
      logger: {
        warn: (msg, extra) => console.error(`[emitter warn] ${msg}`, extra ?? {}),
        error: (msg, extra) => console.error(`[emitter error] ${msg}`, extra ?? {}),
      },
      hooks: {
        onDurablePrepared(event: OutboundEvent): void {
          if (event.type !== "turn.reply" && event.type !== "turn.error") return;
          for (const messageId of resolveMessageIds()) {
            try {
              supervisor.idempotency.saveResponse(adapterId, messageId, event);
            } catch {
              // A message id may already have its response saved from
              // a prior attempt; that is fine for redelivery.
            }
          }
        },
        onDurableDelivered(event: OutboundEvent): void {
          if (event.type !== "turn.reply" && event.type !== "turn.error") return;
          for (const messageId of resolveMessageIds()) {
            try {
              supervisor.idempotency.markSent(adapterId, messageId);
            } catch {
              // Already sent or in an unexpected state; non-fatal.
            }
          }
        },
        onDurableFailed(event: OutboundEvent, error: string): void {
          if (event.type !== "turn.reply" && event.type !== "turn.error") return;
          for (const messageId of resolveMessageIds()) {
            try {
              supervisor.idempotency.markFailed(adapterId, messageId, error);
            } catch {
              // Non-fatal; the response is retained for redelivery.
            }
          }
        },
      },
    });
  }

  /**
   * Resolve the adapter callback target (URL + signing closure). The secret
   * never leaves the adapter registry; the sign closure captures it.
   */
  private resolveAdapterTarget(adapterId: string): AdapterTarget | null {
    if (!this.adapters.has(adapterId)) return null;
    const callbackUrl = this.adapters.getCallbackUrl(adapterId);
    const sign = (body: string): string => this.adapters.signOutbound(adapterId, body);
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
    const args: string[] = ["--mode", "rpc"];
    // Load the production ambient extension explicitly. The staged agent
    // folder at $HOME/.omp/agent preserves tools/skills/agents through
    // default discovery (no --no-extensions flag).
    args.push("-e", extensionPath);
    if (this.config.ompModel) {
      args.push("--model", this.config.ompModel);
    }
    if (this.config.ompProfile) {
      args.push("--profile", this.config.ompProfile);
    }
    args.push("--cwd", this.config.workspaceDir);
    args.push(...this.config.ompArgs);

    const child = new RpcChild({
      binary: this.config.ompBinary,
      args,
      cwd: this.config.workspaceDir,
      registryPath: this.config.childRegistryPath || undefined,
      conversationKey: ctx.registryKey,
    });
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
   * Discard a pending idempotency row, swallowing errors if the row has
   * already transitioned (e.g. by a concurrent completion).
   */
  private discardPending(adapterId: string, messageId: string): void {
    try {
      this.idempotency.discardPendingInbound(adapterId, messageId);
    } catch {
      // Row may have already transitioned; non-fatal for rollback.
    }
  }

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
export function createCoreSupervisor(options: CoreSupervisorOptions): CoreSupervisor {
  return new CoreSupervisor(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Composite conversation key (collision-proof, same algorithm as IngestBuffer). */
function compositeKey(adapterId: string, conversationKey: string): string {
  return `${adapterId.length}:${adapterId}${conversationKey}`;
}
