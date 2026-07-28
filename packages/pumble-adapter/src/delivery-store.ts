import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface DeliveryStoreData {
  completedEventIds: string[];
}

/** Persistent adapter-side dedupe for successfully applied outbound events. */
export class DeliveryStore {
  private completed = new Set<string>();
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  hasCompleted(eventId: string): Promise<boolean> {
    return this.serialize(async () => {
      await this.load();
      return this.completed.has(eventId);
    });
  }

  markCompleted(eventId: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (this.completed.has(eventId)) return;
      this.completed.add(eventId);
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
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isDeliveryStoreData(parsed)) {
        throw new Error(`invalid delivery store at ${this.filePath}`);
      }
      this.completed = new Set(parsed.completedEventIds);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    this.loaded = true;
  }

  private async write(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const data: DeliveryStoreData = {
      completedEventIds: [...this.completed],
    };
    await writeFile(tempPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDeliveryStoreData(value: unknown): value is DeliveryStoreData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ids = (value as Record<string, unknown>).completedEventIds;
  return (
    Array.isArray(ids) &&
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length
  );
}
