import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

interface DeliveryStoreData {
  completedEventIds: string[];
  eventCheckpoints?: Record<string, string[]>;
}

/** Persistent event completion dedupe and confirmed rendering checkpoints. */
export class DeliveryStore {
  private completed = new Set<string>();
  private checkpoints = new Map<string, Set<string>>();
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  hasCompleted(eventId: string): Promise<boolean> {
    return this.serialize(async () => {
      await this.load();
      return this.completed.has(eventId);
    });
  }

  checkpointsFor(eventId: string): Promise<ReadonlySet<string>> {
    return this.serialize(async () => {
      await this.load();
      return new Set(this.checkpoints.get(eventId));
    });
  }

  markCheckpoint(eventId: string, checkpoint: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (this.completed.has(eventId)) return;
      const checkpoints = this.checkpoints.get(eventId) ?? new Set<string>();
      if (checkpoints.has(checkpoint)) return;
      checkpoints.add(checkpoint);
      this.checkpoints.set(eventId, checkpoints);
      await this.write();
    });
  }

  markCompleted(eventId: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (this.completed.has(eventId)) return;
      this.completed.add(eventId);
      this.checkpoints.delete(eventId);
      await this.write();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as unknown;
      if (!isDeliveryStoreData(parsed)) {
        throw new Error(`invalid delivery store at ${this.filePath}`);
      }
      this.completed = new Set(parsed.completedEventIds);
      this.checkpoints = new Map(
        Object.entries(parsed.eventCheckpoints ?? {}).map(
          ([eventId, checkpoints]) => [eventId, new Set(checkpoints)],
        ),
      );
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    this.loaded = true;
  }

  private async write(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const eventCheckpoints = Object.fromEntries(
      [...this.checkpoints].map(([eventId, checkpoints]) => [
        eventId,
        [...checkpoints],
      ]),
    );
    const data: DeliveryStoreData = {
      completedEventIds: [...this.completed],
      ...(this.checkpoints.size > 0 ? { eventCheckpoints } : {}),
    };
    try {
      const temp = await open(tempPath, "wx", 0o600);
      try {
        await temp.writeFile(JSON.stringify(data), "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      await rename(tempPath, this.filePath);
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isDeliveryStoreData(value: unknown): value is DeliveryStoreData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const ids = record.completedEventIds;
  if (
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(ids).size !== ids.length
  ) {
    return false;
  }
  const checkpoints = record.eventCheckpoints;
  if (checkpoints === undefined) return true;
  if (
    !checkpoints ||
    typeof checkpoints !== "object" ||
    Array.isArray(checkpoints)
  ) {
    return false;
  }
  return Object.entries(checkpoints).every(
    ([eventId, values]) =>
      eventId.length > 0 &&
      Array.isArray(values) &&
      values.every(
        (checkpoint) => typeof checkpoint === "string" && checkpoint.length > 0,
      ) &&
      new Set(values).size === values.length,
  );
}
