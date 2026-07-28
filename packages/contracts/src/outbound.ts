/**
 * Outbound webhook contract for the omp-bundler v1 adapter API.
 *
 * These types describe the JSON payloads the omp-bundler core POSTs to an
 * adapter's registered callback URL to notify the adapter of conversation
 * state changes. The adapter is the consumer: it acknowledges each POST (2xx)
 * and applies the event. Adapter identity is supplied by the route
 * (`/v1/adapters/{adapterId}/...`); it is NOT duplicated in event payloads.
 * `conversationKey` is an opaque, stable identifier within that adapter
 * namespace and MUST be treated as a foreign key by the adapter.
 *
 * Transport semantics
 * -------------------
 * The callback URL and a per-adapter shared secret are established during
 * adapter registration, which is a separate contract leaf. These types define
 * only the payload shape and delivery guarantees.
 *
 *   - `eventId`    : Opaque, globally unique per event. The adapter MUST dedupe
 *                    by `eventId`; a redelivery of the same `eventId` is
 *                    idempotent and MUST NOT be applied twice.
 *   - `sequence`   : A positive integer scoped to `correlationId`, monotonically
 *                    increasing within that scope. The adapter SHOULD order
 *                    events per `correlationId` by `sequence`. `sequence` is
 *                    NOT comparable across different `correlationId` values.
 *   - `occurredAt` : UTC ISO 8601 timestamp ending in `Z`, marking when the
 *                    event was generated. It is advisory; `sequence` is
 *                    authoritative for ordering within a correlation.
 *
 * Delivery guarantees
 * -------------------
 *   - `turn.started`, `turn.reply`, `presence.changed`, `turn.error`:
 *       At-least-once with durable retry. The core persists the event and
 *       retries until the adapter acknowledges (2xx) or a terminal backoff is
 *       reached. Redeliveries carry the same `eventId`; dedupe applies.
 *   - `turn.progress`: Best-effort. The core MAY fire progress without durable
 *       persistence and MAY drop or coalesce progress events under load. A
 *       dropped `turn.progress` creates a `sequence` gap; the adapter MUST
 *       tolerate gaps in `sequence` and MUST NOT treat a gap as an error.
 *
 * Reconstruction of completion
 * ----------------------------
 * `turn.reply` and `turn.error` are terminal for a `correlationId`. Because
 * they are delivered at-least-once (durable), the adapter can reconstruct
 * completion of a turn even if every intermediate `turn.progress` was dropped:
 * the arrival of a terminal event closes the turn regardless of how many
 * progress events were observed. The adapter MUST NOT wait indefinitely on
 * progress to infer completion; the terminal event is authoritative.
 */

import type { AdapterApiVersion } from "./shared.js";
import { ADAPTER_API_VERSION } from "./shared.js";
import type { WorkspaceAttachment } from "./shared.js";

/**
 * Media type for outbound webhook POST bodies. The adapter SHOULD verify the
 * `Content-Type` header equals this value exactly.
 */
export const OUTBOUND_EVENT_MEDIA_TYPE =
  "application/vnd.omp-bundler.outbound.v1+json" as const;

/**
 * Header carrying the event media type. Sent on every webhook POST.
 */
export const OUTBOUND_EVENT_CONTENT_TYPE_HEADER = "Content-Type" as const;

/**
 * Header carrying the opaque webhook signature over the request body. v1
 * registration establishes a per-adapter shared secret, so this header is
 * always present. The adapter MUST verify it before processing the event;
 * verification is defined by the registration/auth leaf.
 */
export const OUTBOUND_EVENT_SIGNATURE_HEADER =
  "X-OMP-Bundler-Signature" as const;

/**
 * Header carrying the discriminated event `type` so the adapter can route a
 * payload without parsing the body first. Its value MUST match the `type`
 * field in the JSON body.
 */
export const OUTBOUND_EVENT_TYPE_HEADER = "X-OMP-Bundler-Event" as const;

/**
 * All event discriminator values.
 */
export type OutboundEventType =
  | "turn.started"
  | "turn.progress"
  | "turn.reply"
  | "presence.changed"
  | "turn.error";

/**
 * Presence states of the core agent within a conversation.
 */
export type Presence = "active" | "idle" | "offline";

/**
 * Fields common to every outbound event. The `type` discriminator and
 * `version` are present on all variants; `version` is always the literal
 * {@link ADAPTER_API_VERSION} (`"v1"`).
 */
export interface OutboundEventBase {
  /** API contract version; always `"v1"`. */
  version: AdapterApiVersion;
  /** Discriminator selecting the event variant. */
  type: OutboundEventType;
  /** Opaque, globally unique identifier for this event. Used for dedupe. */
  eventId: string;
  /**
   * Opaque, stable conversation identifier within the adapter namespace.
   * Foreign key to the adapter's conversation model.
   */
  conversationKey: string;
  /**
   * Opaque identifier correlating the events of a single turn/interaction.
   * `sequence` is ordered within this scope.
   */
  correlationId: string;
  /**
   * Positive integer, monotonically increasing per `correlationId`.
   * The adapter orders by this within a correlation; gaps may occur from
   * dropped best-effort `turn.progress` events.
   */
  sequence: number;
  /** UTC ISO 8601 timestamp ending in `Z`, marking event generation. Advisory. */
  occurredAt: string;
}

/**
 * Emitted when a turn begins for a correlation. Always precedes `turn.reply`
 * or `turn.error` for the same `correlationId` in a gap-free delivery.
 * Delivered at-least-once.
 */
export interface TurnStartedEvent extends OutboundEventBase {
  type: "turn.started";
}

/**
 * Best-effort progress notification carrying a human-readable status message.
 * May be dropped or coalesce; a drop creates a `sequence` gap that the adapter
 * MUST tolerate. Never terminal.
 */
export interface TurnProgressEvent extends OutboundEventBase {
  type: "turn.progress";
  /** Human-readable progress text, suitable for direct display. */
  message: string;
}

/**
 * Token usage for a completed turn reply. All counts are nonnegative integers.
 */
export interface TurnUsage {
  /** Nonnegative integer. Non-prompt input tokens. */
  input: number;
  /** Nonnegative integer. Generated output tokens. */
  output: number;
  /** Nonnegative integer. Cached prompt tokens read. */
  cacheRead: number;
  /** Nonnegative integer. Prompt tokens written to cache. */
  cacheWrite: number;
  /**
   * Nonnegative numeric cost in USD for the turn. May be fractional; not an
   * integer count.
   */
  costUsd: number;
}

/**
 * Terminal event carrying the completed turn reply. Delivered at-least-once.
 * `attachments` are workspace-relative POSIX paths (see {@link WorkspaceAttachment});
 * bytes are never inlined. The adapter enforces path safety at read time.
 *
 * Both `text` and `attachments` are always present. `text` may be the empty
 * string for an attachment-only reply, but the pair (empty text, empty
 * attachments) is invalid and rejected by the schema.
 */
export interface TurnReplyEvent extends OutboundEventBase {
  type: "turn.reply";
  /** Reply text. May be empty only when `attachments` is non-empty. */
  text: string;
  /**
   * Workspace-relative output attachments. May be empty only when `text` is
   * non-empty.
   */
  attachments: WorkspaceAttachment[];
  /** Token usage and cost for the turn. */
  usage: TurnUsage;
}

/**
 * Presence change of the core agent within a conversation. Delivered
 * at-least-once.
 */
export interface PresenceChangedEvent extends OutboundEventBase {
  type: "presence.changed";
  /** New presence state of the core agent. */
  presence: Presence;
}

/**
 * Terminal error for a correlation. Delivered at-least-once. The arrival of
 * this event closes the turn; the adapter MUST NOT expect a subsequent
 * `turn.reply` for the same `correlationId`.
 */
export interface TurnErrorEvent extends OutboundEventBase {
  type: "turn.error";
  /** Stable, machine-readable error code. Not localized. */
  code: string;
  /** Curated, human-readable error message suitable for display. */
  message: string;
  /**
   * Whether the core failure is transient. Reports the nature of the failure,
   * not permission to replay an already-accepted inbound message; a new
   * inbound request is required to retry.
   */
  retryable: boolean;
}

/**
 * Discriminated union of all outbound webhook events. Discriminate on `type`.
 */
export type OutboundEvent =
  | TurnStartedEvent
  | TurnProgressEvent
  | TurnReplyEvent
  | PresenceChangedEvent
  | TurnErrorEvent;

export {
  ADAPTER_API_VERSION,
};