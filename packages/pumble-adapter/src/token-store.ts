import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

  constructor(private readonly filePath: string) {}

  async saveOAuthPayload(payload: Record<string, unknown>) {
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
  }

  async getWorkspace(workspaceId: string) {
    await this.load();
    const tokens = this.data.workspaces[workspaceId];
    return tokens ? { ...tokens } : null;
  }

  async deleteWorkspace(workspaceId: string) {
    await this.load();
    delete this.data.workspaces[workspaceId];
    await this.write();
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
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        this.data = { workspaces: {} };
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
  }

  private async write() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isValidTokenData(value: unknown): value is TokenStoreData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const workspaces = record.workspaces;
  if (workspaces === null || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return false;
  }
  const wsRecord = workspaces as Record<string, unknown>;
  for (const entry of Object.values(wsRecord)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
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
