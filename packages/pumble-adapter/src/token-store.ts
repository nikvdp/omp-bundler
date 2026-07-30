import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceTokens {
  workspaceId: string;
  accessToken?: string;
  botToken?: string;
  userId?: string;
  botId?: string;
}

interface TokenStoreData {
  workspaces: Record<string, WorkspaceTokens>;
}

export class TokenStore {
  private data: TokenStoreData = { workspaces: {} };
  private loaded = false;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  saveOAuthPayload(payload: Record<string, unknown>): Promise<void> {
    return this.serialize(async () => {
      const workspaceId = stringField(payload, "workspaceId");
      await this.load();
      this.data.workspaces[workspaceId] = {
        workspaceId,
        accessToken: optionalString(payload.accessToken),
        botToken: optionalString(payload.botToken),
        userId: optionalString(payload.userId),
        botId: optionalString(payload.botId),
      };
      await this.write();
    });
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceTokens | null> {
    return this.serialize(async () => {
      await this.load();
      const tokens = this.data.workspaces[workspaceId];
      return tokens ? { ...tokens } : null;
    });
  }

  deleteWorkspace(workspaceId: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      delete this.data.workspaces[workspaceId];
      await this.write();
    });
  }

  /**
   * Load the token file once. Only ENOENT (file does not exist) is treated as
   * a fresh start with an empty store. Any other read or parse failure is a
   * loud error: corruption or unreadable files never silently reset tokens.
   */
  private async load() {
    if (this.loaded) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        this.data = { workspaces: {} };
        this.loaded = true;
        return;
      }
      throw new Error(
        `token store at ${this.filePath} is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `token store at ${this.filePath} is corrupt (invalid JSON): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isValidTokenData(parsed)) {
      throw new Error(
        `token store at ${this.filePath} is corrupt: expected an object with a workspaces map`,
      );
    }
    this.data = parsed;
    this.loaded = true;
  }

  private async write() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const temp = await open(tempPath, "wx", 0o600);
      try {
        await temp.writeFile(JSON.stringify(this.data, null, 2), "utf8");
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

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operationChain.catch(() => undefined).then(action);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isValidTokenData(value: unknown): value is TokenStoreData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const workspaces = record.workspaces;
  if (
    workspaces === null ||
    typeof workspaces !== "object" ||
    Array.isArray(workspaces)
  ) {
    return false;
  }
  const wsRecord = workspaces as Record<string, unknown>;
  for (const [workspaceId, entry] of Object.entries(wsRecord)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const tokens = entry as Record<string, unknown>;
    if (
      !workspaceId ||
      tokens.workspaceId !== workspaceId ||
      !Object.keys(tokens).every((key) =>
        ["workspaceId", "accessToken", "botToken", "userId", "botId"].includes(
          key,
        ),
      )
    ) {
      return false;
    }
    for (const key of ["accessToken", "botToken", "userId", "botId"] as const) {
      if (
        tokens[key] !== undefined &&
        (typeof tokens[key] !== "string" || tokens[key].length === 0)
      ) {
        return false;
      }
    }
  }
  return true;
}

function stringField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OAuth payload missing ${key}`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
