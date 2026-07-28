/**
 * Inbound message contract for the omp-bundler adapter API, version 1.
 *
 * Route: POST /v1/adapters/{adapterId}/messages
 *
 * `adapterId` is supplied by the route and is NOT duplicated in the request
 * payload. `conversationKey` is opaque and stable within that adapter
 * namespace; the core never inspects or parses its internal structure.
 *
 * Idempotency: the deduplication key is the pair (adapterId, messageId).
 *   - First acceptance returns HTTP 202 with `status: "accepted"`.
 *   - Identical replay (same key, same canonical payload) returns HTTP 200
 *     with `status: "duplicate"` and the ORIGINAL correlation id.
 *   - Same key plus a different canonical payload is a conflict and is
 *     rejected (HTTP 409); the original correlation id is unchanged.
 *   - The correlation id is core-generated, opaque, and stable for all
 *     replays of the same (adapterId, messageId) pair.
 *
 * Attachments are workspace-relative POSIX paths (see WorkspaceAttachment in
 * shared.ts). Consumers enforce runtime path safety; this contract never
 * carries inline bytes.
 */

import type { Speaker, WorkspaceAttachment } from "./shared.js";

/** Media type for the inbound message request and acceptance response. */
export const INBOUND_MESSAGE_MEDIA_TYPE =
  "application/vnd.omp-bundler.inbound-message.v1+json" as const;

/** Endpoint path template. `{adapterId}` is the route parameter. */
export const INBOUND_MESSAGE_ENDPOINT =
  "/v1/adapters/{adapterId}/messages" as const;

/** Acceptance status for a synchronous inbound message response. */
export type InboundMessageStatus = "accepted" | "duplicate";

/**
 * Request body for POST /v1/adapters/{adapterId}/messages.
 *
 * Both `text` and `attachments` are always present. `text` may be the empty
 * string for an attachment-only message, but the pair (empty text, empty
 * attachments) is invalid and rejected by the schema.
 */
export interface InboundMessage {
  /** Non-empty opaque string identifying this message within the adapter. */
  messageId: string;
  /**
   * Opaque, stable conversation key within the adapter namespace. Two
   * messages sharing this key belong to the same conversation.
   */
  conversationKey: string;
  /** The party that produced the message. */
  speaker: Speaker;
  /**
   * Message text. May be empty only when `attachments` is non-empty.
   */
  text: string;
  /**
   * Attachments referenced by workspace-relative POSIX path. May be empty
   * only when `text` is non-empty.
   */
  attachments: WorkspaceAttachment[];
  /**
   * Whether the agent was directly invoked by this message (activation
   * policy seam). `true` means the message explicitly targets the agent;
   * `false` means it is ambient/contextual within the conversation.
   */
  addressed: boolean;
}

/**
 * Synchronous acceptance response for an inbound message.
 *
 * First acceptance returns HTTP 202; identical replay returns HTTP 200 with
 * `status: "duplicate"` and the same correlation id. Validated by the
 * `inbound-accepted-v1.json` schema.
 *
 * `correlationId` is core-generated, opaque, and stable for every replay of
 * the same (adapterId, messageId) pair.
 */
export interface InboundMessageAccepted {
  status: InboundMessageStatus;
  correlationId: string;
}