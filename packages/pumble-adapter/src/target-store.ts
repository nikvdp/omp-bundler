import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Resolved Pumble channel target for a conversation/correlation.
 *
 * Produced during inbound NEW_MESSAGE processing and persisted so the
 * outbound renderer can resolve the channel, trigger message, and thread
 * root for a correlation even across a process restart.
 */
export interface Target {
  workspaceId: string;
  channelId: string;
  triggerMessageId: string;
  threadRootId?: string;
}

interface TargetStoreData {
  /** Maps conversationKey -> Target. Written before the core POST. */
  byConversation: Record<string, Target>;
  /** Maps correlationId -> Target. Written after core accepts. */
  byCorrelation: Record<string, Target>;
}

/**
 * Atomic, durable target store for the Pumble adapter.
 *
 * Persists the resolved Pumble channel context (channel id, trigger message
 * id, optional thread root) for each conversation and correlation so the
 * outbound renderer can deliver callbacks even after a restart.
 *
 * Write protocol (race-safe against early outbound callbacks):
 *   1. Before the core POST, call {@link putByConversation} with the
 *      resolved target keyed by conversationKey. This survives restart.
 *   2. After core accepts and returns a correlationId, call
 *      {@link bindCorrelation} to map that correlation to the same target.
 *   3. The outbound resolver tries correlationId first (precise), then
 *      falls back to conversationKey (same channel has one active turn).
 *
 * All writes are serialized through a single promise chain and use atomic
 * rename (temp file then rename) for durability. Corruption or unreadable
 * files fail loudly; the store never silently resets to empty.
 */
export class TargetStore {
  private data: TargetStoreData = { byConversation: {}, byCorrelation: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * Persist a target under conversationKey. Called BEFORE the core POST so
   * an early outbound callback can resolve via conversationKey fallback.
   */
  putByConversation(conversationKey: string, target: Target): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      this.data.byConversation[conversationKey] = { ...target };
      await this.write();
    });
  }

  /**
   * Bind a correlationId to the same target already stored under
   * conversationKey, or to an explicitly provided target. Called AFTER
   * core accepts the inbound message and returns a correlationId.
   */
  bindCorrelation(
    conversationKey: string,
    correlationId: string,
    target?: Target,
  ): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      const resolved = target ?? this.data.byConversation[conversationKey];
      if (!resolved) {
        throw new Error(
          `cannot bind correlation ${correlationId}: no target found for conversationKey ${conversationKey}`,
        );
      }
      this.data.byCorrelation[correlationId] = { ...resolved };
      await this.write();
    });
  }

  /**
   * Resolve a target for an outbound event. Tries correlationId first
   * (precise per-turn), then falls back to conversationKey (same channel
   * has one active turn by contract).
   */
  async resolve(conversationKey: string, correlationId: string): Promise<Target | null> {
    await this.load();
    const byCorrelation = this.data.byCorrelation[correlationId];
    if (byCorrelation) {
      return { ...byCorrelation };
    }
    const byConversation = this.data.byConversation[conversationKey];
    if (byConversation) {
      return { ...byConversation };
    }
    return null;
  }

  /**
   * Remove a correlation binding after the terminal event is fully
   * delivered and acknowledged. Conversation bindings are retained so a
   * subsequent turn on the same channel resolves without re-resolution.
   */
  forgetCorrelation(correlationId: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      delete this.data.byCorrelation[correlationId];
      await this.write();
    });
  }

  /**
   * Load the store file once. Only ENOENT is treated as a fresh start.
   * Corruption or unreadable files throw loudly.
   */
  private async load() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        this.data = { byConversation: {}, byCorrelation: {} };
        return;
      }
      throw new Error(
        `target store at ${this.filePath} is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `target store at ${this.filePath} is corrupt (invalid JSON): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isValidStoreData(parsed)) {
      throw new Error(
        `target store at ${this.filePath} is corrupt: expected an object with byConversation and byCorrelation maps`,
      );
    }
    this.data = parsed;
  }

  private async write() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const temp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  /**
   * Serialize all mutations through a single promise chain so concurrent
   * putByConversation / bindCorrelation / forgetCorrelation calls never
   * interleave their read-modify-write cycles.
   */
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.writeChain
      .catch(() => {
        // A prior write failure must not block subsequent mutations.
      })
      .then(() => action());
    this.writeChain = next;
    return next;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isValidStoreData(value: unknown): value is TargetStoreData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isTargetMap(record.byConversation) && isTargetMap(record.byCorrelation)
  );
}

function isTargetMap(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    if (!isValidTarget(entry)) {
      return false;
    }
  }
  return true;
}

function isValidTarget(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceId === "string" &&
    record.workspaceId.length > 0 &&
    typeof record.channelId === "string" &&
    record.channelId.length > 0 &&
    typeof record.triggerMessageId === "string" &&
    record.triggerMessageId.length > 0 &&
    (record.threadRootId === undefined || typeof record.threadRootId === "string")
  );
}
