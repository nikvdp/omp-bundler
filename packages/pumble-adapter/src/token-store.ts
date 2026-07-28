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

  private async load() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      this.data = JSON.parse(await readFile(this.filePath, "utf8")) as TokenStoreData;
    } catch {
      this.data = { workspaces: {} };
    }
  }

  private async write() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
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
