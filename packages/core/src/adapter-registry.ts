/**
 * Immutable, declarative, in-memory registry of adapter registrations for the
 * omp-bundler v1 adapter API.
 *
 * The registry is constructed once from an explicit list of
 * {adapterId, callbackUrl, sharedSecret} records supplied by the operator at
 * process start. There is NO dynamic discovery, registration API, plugin
 * loader, database, or auth framework here: the supervisor owns the full set
 * of adapters up front, and this object simply serves lookups and the two
 * authentication primitives (inbound secret verification, outbound HMAC
 * signing) that the adapter transport contract requires.
 *
 * Secret boundary
 * ----------------
 * The shared secret is never returned by any method, never copied into error
 * messages, and never exposed via iteration. `listAdapters` yields only
 * {adapterId, callbackUrl}. Internally each stored record is frozen so callers
 * cannot mutate the secret in place. Validation errors quote the adapter id and
 * the callback URL when relevant, never the secret.
 *
 * Identity / storage key
 * ----------------------
 * Adapter identity is route scoped: an inbound request is dispatched as
 * POST /v1/adapters/{adapterId}/messages, and every conversation is identified
 * by the tuple (adapterId, conversationKey) where conversationKey is an opaque
 * raw string the core never interprets. Core stores that namespace every
 * conversation by this tuple, NEVER by unsafe string concatenation. The
 * {@link AdapterRegistry.storageKey} method returns a length-prefixed,
 * delimiter-free, fully injective encoding of the tuple that is collision-proof
 * even when adapterId or conversationKey contain delimiter-like bytes (NUL,
 * colon, slash, newline, etc).
 *
 * Authentication
 * ---------------
 * Inbound: the adapter presents the per-adapter shared secret over the
 * transport; the core compares it to the registered secret in constant time
 * via {@link timingSafeEqual}. Outbound: the core signs the EXACT UTF-8 bytes of
 * the webhook body it POSTs to the adapter callback, producing the header value
 * "sha256=<lowercase hex HMAC-SHA256(secret, body)>"; the adapter verifies it.
 *
 * Construction is atomic: either every entry validates and the registry is
 * built, or no registry is built and a single {@link AdapterRegistrationError}
 * names the offending entry. No silent fallbacks, no partial state.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { OUTBOUND_EVENT_SIGNATURE_HEADER } from "@omp-bundler/contracts/outbound";

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Header carrying the presented shared secret on an inbound adapter request.
 * The adapter MUST send this header with the raw secret as its value; the core
 * reads it and compares in constant time via
 * {@link AdapterRegistry.authenticateInbound}. This is a bare shared-secret
 * comparison, not a bearer-token framework or HMAC over the inbound body.
 */
export const INBOUND_SECRET_HEADER = "X-OMP-Bundler-Adapter-Secret" as const;

/**
 * The outbound webhook signature header name (re-exported from the contracts
 * package so callers can import the full auth surface from one module). Its
 * value is produced by {@link AdapterRegistry.signOutbound} as
 * `sha256=<lowercase hex>`.
 */
export { OUTBOUND_EVENT_SIGNATURE_HEADER };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single declarative adapter registration supplied to the registry
 * constructor. All three fields are required and validated.
 */
export interface AdapterRegistration {
  /** Non-empty, unique adapter id (route scoped). */
  adapterId: string;
  /** Absolute `http:` or `https:` callback URL the core POSTs events to. */
  callbackUrl: string;
  /** Non-empty shared secret for inbound auth and outbound signing. */
  sharedSecret: string;
}

/** Secret-free projection of a registration, as returned by listAdapters. */
export interface AdapterDescriptor {
  readonly adapterId: string;
  readonly callbackUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Prefix of every outbound signature header value, per the v1 contract.
 * Followed by the lowercase hex HMAC-SHA256 digest of the body.
 */
const SIGNATURE_PREFIX = "sha256=" as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the {@link AdapterRegistry} constructor when one or more entries
 * fail validation: empty id, non-HTTP(S) callback URL, empty secret, or a
 * duplicate adapter id. The message never contains a shared secret. The
 * constructor never produces a partial registry: on failure no registry is
 * constructed and this error is the only observable result.
 */
export class AdapterRegistrationError extends Error {
  /** Id of the offending entry, when known. Never a secret. */
  readonly adapterId?: string;

  constructor(message: string, adapterId?: string) {
    super(message);
    this.name = "AdapterRegistrationError";
    if (adapterId !== undefined) this.adapterId = adapterId;
  }
}

/**
 * Thrown by {@link AdapterRegistry.getCallbackUrl},
 * {@link AdapterRegistry.authenticateInbound}, and
 * {@link AdapterRegistry.signOutbound} when no registration exists for the
 * supplied adapter id. Distinct from a failed authentication: an unknown
 * adapter is a routing/registration problem, not a credential mismatch.
 */
export class UnknownAdapterError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string) {
    super(`unknown adapter: "${adapterId}" is not registered`);
    this.name = "UnknownAdapterError";
    this.adapterId = adapterId;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate a callback URL as an absolute http(s) URL. Returns null if
 * the string is not a parseable absolute URL with an http: or https: protocol.
 * Never throws; the caller lifts the failure into a typed
 * {@link AdapterRegistrationError}.
 */
function parseCallbackUrl(callbackUrl: string): URL | null {
  if (typeof callbackUrl !== "string" || callbackUrl.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed;
}

/**
 * Constant-time equality of two UTF-8 strings.
 *
 * Uses {@link timingSafeEqual} on the raw bytes. When the lengths differ,
 * `timingSafeEqual` cannot be applied directly, so a dummy self-comparison of
 * the registered secret is performed first to keep the work profile constant
 * regardless of the candidate, then false is returned. The registered secret's
 * length is therefore never revealed through an early return; the only timing
 * signal is proportional to the stored secret length, which is identical on
 * every call for a given adapter.
 */
function secretEquals(candidate: string, registered: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(registered, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// AdapterRegistry
// ---------------------------------------------------------------------------

/**
 * Immutable, in-memory registry of adapter registrations with constant-time
 * inbound secret verification and outbound HMAC-SHA256 signing.
 *
 * Construct once from an explicit list; the instance exposes no mutators. All
 * lookups are O(1) over a frozen map keyed by adapter id. Secrets remain
 * internal: public methods return descriptor records that omit the secret.
 */
export class AdapterRegistry {
  /**
   * Frozen registrations keyed by adapter id. The map reference is readonly and
   * the entries are frozen, so neither the set of adapters nor any stored
   * secret can be mutated after construction.
   */
  private readonly byId: ReadonlyMap<string, Readonly<AdapterRegistration>>;

  /**
   * Validate every entry and build the registry. Throws a single
   * {@link AdapterRegistrationError} on the first invalid entry; on failure no
   * registry is produced.
   */
  constructor(registrations: readonly AdapterRegistration[]) {
    const map = new Map<string, Readonly<AdapterRegistration>>();

    if (!Array.isArray(registrations)) {
      throw new AdapterRegistrationError("registrations must be an array");
    }

    for (const entry of registrations) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      ) {
        throw new AdapterRegistrationError("each registration must be an object");
      }

      const { adapterId, callbackUrl, sharedSecret } = entry;

      if (typeof adapterId !== "string" || adapterId.length === 0) {
        throw new AdapterRegistrationError("adapterId must be a non-empty string");
      }

      if (parseCallbackUrl(callbackUrl) === null) {
        throw new AdapterRegistrationError(
          `callbackUrl for adapter "${adapterId}" must be an absolute http(s) URL`,
          adapterId,
        );
      }

      if (typeof sharedSecret !== "string" || sharedSecret.length === 0) {
        throw new AdapterRegistrationError(
          `sharedSecret for adapter "${adapterId}" must be a non-empty string`,
          adapterId,
        );
      }

      if (map.has(adapterId)) {
        throw new AdapterRegistrationError(
          `duplicate adapterId "${adapterId}"`,
          adapterId,
        );
      }

      // Store a frozen copy so the caller cannot later mutate the secret or
      // swap the record out by holding the original reference.
      const frozen: AdapterRegistration = Object.freeze({
        adapterId,
        callbackUrl,
        sharedSecret,
      });
      map.set(adapterId, frozen);
    }

    this.byId = map;
  }

  /**
   * True iff an adapter with this id is registered. Does not differentiate
   * between registered-but-bad-credential and registered; existence only.
   */
  has(adapterId: string): boolean {
    return this.byId.has(adapterId);
  }

  /**
   * Return the callback URL for an adapter. Throws
   * {@link UnknownAdapterError} if the adapter is not registered. The returned
   * value is the callback URL exactly as registered (validated as absolute
   * http(s) at construction); never a secret.
   */
  getCallbackUrl(adapterId: string): string {
    const entry = this.require(adapterId);
    return entry.callbackUrl;
  }

  /**
   * Verify a presented shared secret for an adapter in constant time.
   *
   * Throws {@link UnknownAdapterError} if the adapter is not registered: an
   * unknown adapter is a routing failure, distinct from a credential mismatch.
   * For a registered adapter, returns true iff `presentedSecret` equals the
   * registered secret, compared with {@link timingSafeEqual} and no early
   * return on length mismatch.
   */
  authenticateInbound(adapterId: string, presentedSecret: string): boolean {
    const entry = this.require(adapterId);
    return secretEquals(presentedSecret, entry.sharedSecret);
  }

  /**
   * Produce the outbound webhook signature header VALUE for an adapter over
   * the exact request body bytes: `sha256=<lowercase hex HMAC-SHA256(secret,
   * body)>`.
   *
   * `body` is the exact UTF-8 the core will POST. It MUST be the exact bytes
   * sent on the wire: pass the serialized JSON string (encoded UTF-8 here) or,
   * if the transport already holds a byte buffer, pass that buffer so the
   * signature is over the literal wire bytes, not a re-serialization. The
   * returned value is paired with the
   * {@link OUTBOUND_EVENT_SIGNATURE_HEADER} header name.
   *
   * Throws {@link UnknownAdapterError} if the adapter is not registered.
   */
  signOutbound(adapterId: string, body: string | Uint8Array): string {
    const entry = this.require(adapterId);
    const hmac = createHmac("sha256", entry.sharedSecret);
    if (typeof body === "string") {
      hmac.update(body, "utf8");
    } else {
      hmac.update(body);
    }
    return SIGNATURE_PREFIX + hmac.digest("hex");
  }


  /**
   * Return a collision-proof identity/storage key for a conversation from the
   * tuple (adapterId, conversationKey) using a length-prefixed, delimiter-free
   * injective encoding.
   *
   * The encoding is `<adapterId.length>:<adapterId><conversationKey>`. The
   * leading decimal length is followed by a single colon, then exactly
   * `adapterId.length` characters of adapterId, then the remainder is
   * conversationKey. Decoding reads the length, advances past the colon, takes
   * that many characters as adapterId, and treats the rest as conversationKey.
   * This is a bijection and therefore collision-proof for ALL string inputs,
   * including conversationKey values that contain NUL, colon, slash, digits, or
   * any delimiter-like byte: the split point is fixed by the length prefix, so
   * no content of either field can shift the boundary.
   *
   * This never uses unsafe concatenation or a bare delimiter (a NUL join is
   * unsafe because conversationKey may contain NUL). The method is a pure
   * function of the tuple and does not consult the registry, so it is safe to
   * call before or independent of registration; it is, however, the key the
   * core uses for all per-conversation storage so that two adapters using the
   * same conversationKey never collide.
   */
  static storageKey = conversationStorageKey;

  /**
   * Snapshot of all registered adapters as secret-free descriptors, in
   * construction order. The returned array is a fresh copy; mutating it does
   * not affect the registry. Each descriptor omits the shared secret.
   */
  listAdapters(): AdapterDescriptor[] {
    const out: AdapterDescriptor[] = [];
    for (const entry of this.byId.values()) {
      out.push({ adapterId: entry.adapterId, callbackUrl: entry.callbackUrl });
    }
    return out;
  }

  /**
   * Resolve a registration or throw {@link UnknownAdapterError}. Internal
   * accessor so every public lookup produces identical unknown-adapter
   * semantics.
   */
  private require(adapterId: string): Readonly<AdapterRegistration> {
    const entry = this.byId.get(adapterId);
    if (entry === undefined) {
      throw new UnknownAdapterError(adapterId);
    }
    return entry;
  }
}

/**
 * Collision-proof key for the adapter-scoped conversation tuple.
 *
 * The decimal length prefix fixes the split point even when either opaque
 * value contains colons, NULs, slashes, or newlines.
 */
export function conversationStorageKey(
  adapterId: string,
  conversationKey: string,
): string {
  return `${adapterId.length}:${adapterId}${conversationKey}`;
}