import { mkdir, rm, open } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import type { PumbleApi } from "./pumble-api.js";
import type { WorkspaceTokens } from "./token-store.js";

/**
 * A single attachment on a Pumble message.
 *
 * Ported from the reference `pumble-event.ts`, which is not yet present in
 * this skeleton. Only the fields the download path consumes are kept here so
 * this module is self-contained; the event normalization work can later
 * re-export or replace this shape.
 */
export interface PumbleMessageFile {
  id: string;
  owner?: string;
  name: string;
  mimeType?: string;
  path?: string;
  publicPath?: string;
  size?: number;
}

/**
 * The subset of a parsed Pumble `NEW_MESSAGE` event that the attachment
 * download path needs. See {@link PumbleMessageFile} for the provenance note.
 */
export interface PumbleMessageFilesEvent {
  workspaceId: string;
  channelId: string;
  authorId: string;
  messageId: string;
  threadRootId?: string;
  files: PumbleMessageFile[];
}

/**
 * Result of attempting to download one attachment.
 *
 * `workspacePath` is the path that crosses the adapter seam: it is relative to
 * the shared agent workspace root (the parent of `pumbleFileDir`), never
 * inline bytes. The core and the adapter mount the same volume, so the agent
 * resolves it against its own workspace root. `localPath` is the absolute
 * filesystem path the adapter used and is kept for adapter-internal cleanup.
 */
export interface SavedPumbleFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  pumblePath?: string;
  publicPath?: string;
  localPath?: string;
  workspacePath?: string;
  bytesSaved?: number;
  error?: string;
}

export async function savePumbleFiles(
  config: BridgeConfig,
  pumble: PumbleApi,
  workspaceTokens: WorkspaceTokens,
  event: PumbleMessageFilesEvent,
) {
  const saved: SavedPumbleFile[] = [];
  for (const file of event.files) {
    saved.push(await savePumbleFile(config, pumble, workspaceTokens, event, file));
  }
  return saved;
}

async function savePumbleFile(
  config: BridgeConfig,
  pumble: PumbleApi,
  workspaceTokens: WorkspaceTokens,
  event: PumbleMessageFilesEvent,
  file: PumbleMessageFile,
): Promise<SavedPumbleFile> {
  const base: SavedPumbleFile = {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    pumblePath: file.path,
    publicPath: file.publicPath,
  };

  if (file.size && file.size > config.pumbleFileMaxBytes) {
    return {
      ...base,
      error: `File is ${file.size} bytes, above limit ${config.pumbleFileMaxBytes}.`,
    };
  }

  const fileUrl = fileDownloadUrl(config, file);
  if (!fileUrl) {
    return { ...base, error: "Pumble file did not include a downloadable path." };
  }

  const token = workspaceTokens.accessToken || workspaceTokens.botToken;
  if (!token) {
    return { ...base, error: "Workspace token is missing for file download." };
  }

  const localPath = path.join(
    config.pumbleFileDir,
    safePathPart(event.workspaceId),
    safePathPart(event.channelId),
    safePathPart(event.authorId),
    safePathPart(event.threadRootId || event.messageId),
    `${safePathPart(file.id || "file")}-${safeFilename(file.name)}`,
  );

  try {
    await mkdir(path.dirname(localPath), { recursive: true });
    const response = await pumble.fetchFile(config.appKey, token, fileUrl);
    const bytesSaved = await writeResponseBody(response, localPath, config.pumbleFileMaxBytes);
    const workspacePath = workspaceRelativePath(config, localPath);
    return { ...base, localPath, workspacePath, bytesSaved };
  } catch (error) {
    await rm(localPath, { force: true });
    return {
      ...base,
      localPath,
      workspacePath: workspaceRelativePath(config, localPath),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The path that crosses the adapter seam: `localPath` expressed relative to
 * the shared agent workspace root. Both the adapter and the core mount the
 * same volume at that root, so the agent resolves this against its own
 * workspace root and reads exactly what the adapter wrote.
 */
function workspaceRelativePath(config: BridgeConfig, localPath: string) {
  const workspaceRoot = path.dirname(config.pumbleFileDir);
  const relative = path.relative(workspaceRoot, localPath);
  return relative.split(path.sep).join("/");
}

function fileDownloadUrl(config: BridgeConfig, file: PumbleMessageFile) {
  const candidate = file.path || file.publicPath || "";
  if (!candidate) {
    return "";
  }
  try {
    return new URL(candidate).toString();
  } catch {
    return new URL(
      candidate.startsWith("/") ? candidate : `/${candidate}`,
      config.pumbleFileHostBaseUrl,
    ).toString();
  }
}

async function writeResponseBody(response: Response, localPath: string, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Pumble file response did not include a readable body.");
  }

  let bytesSaved = 0;
  const handle = await open(localPath, "w", 0o600);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return bytesSaved;
      }
      if (!value) {
        continue;
      }
      bytesSaved += value.byteLength;
      if (bytesSaved > maxBytes) {
        throw new Error(`File exceeded limit ${maxBytes} bytes while downloading.`);
      }
      await handle.write(Buffer.from(value));
    }
  } finally {
    await handle.close();
    reader.releaseLock();
  }
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function safeFilename(value: string) {
  const basename = path.basename(value).replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return basename.slice(0, 160) || "pumble-file";
}