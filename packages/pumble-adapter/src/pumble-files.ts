import {
  mkdir,
  rm,
  open,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
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
    saved.push(
      await savePumbleFile(config, pumble, workspaceTokens, event, file),
    );
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

  let fileUrl: string;
  try {
    fileUrl = resolvePumbleFileDownloadUrl(
      config,
      file.path || file.publicPath || "",
    );
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const token = workspaceTokens.accessToken || workspaceTokens.botToken;
  if (!token) {
    return { ...base, error: "Workspace token is missing for file download." };
  }

  const finalName = `${safePathPart(file.id || "file")}-${safeFilename(file.name)}`;
  const requestedDirectory = path.join(
    config.pumbleFileDir,
    safePathPart(event.workspaceId),
    safePathPart(event.channelId),
    safePathPart(event.authorId),
    safePathPart(event.threadRootId || event.messageId),
  );
  let localPath = path.join(requestedDirectory, finalName);
  let cleanupPath: string | undefined;
  let directoryHandle: FileHandle | undefined;

  try {
    await mkdir(config.pumbleFileDir, { recursive: true });
    const configuredRoot = path.resolve(config.pumbleFileDir);
    const realRoot = await realpath(configuredRoot);
    if (realRoot !== configuredRoot) {
      throw new Error("Pumble file root must not be a symbolic link");
    }
    await mkdir(requestedDirectory, { recursive: true });
    const realDirectory = await realpath(requestedDirectory);
    assertContained(realRoot, realDirectory);

    directoryHandle = await open(
      realDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryRef = secureDirectoryReference(directoryHandle.fd);
    const openedDirectory = await realpath(directoryRef);
    assertContained(realRoot, openedDirectory);
    if (openedDirectory !== realDirectory) {
      throw new Error("Pumble file destination changed while opening it");
    }

    const tempName = `${finalName}.${randomBytes(6).toString("hex")}.tmp`;
    cleanupPath = path.join(directoryRef, tempName);
    const response = await pumble.fetchFile(config.appKey, token, fileUrl);
    const bytesSaved = await writeResponseBody(
      response,
      cleanupPath,
      config.pumbleFileMaxBytes,
    );
    if ((await realpath(directoryRef)) !== realDirectory) {
      throw new Error("Pumble file destination changed during download");
    }
    const finalPath = path.join(directoryRef, finalName);
    await rename(cleanupPath, finalPath);
    cleanupPath = finalPath;
    localPath = path.join(realDirectory, finalName);
    const workspacePath = workspaceRelativePath(config, localPath);
    cleanupPath = undefined;
    return { ...base, localPath, workspacePath, bytesSaved };
  } catch (error) {
    if (cleanupPath) await rm(cleanupPath, { force: true });
    return {
      ...base,
      localPath,
      workspacePath: workspaceRelativePath(config, localPath),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await directoryHandle?.close();
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
function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Pumble file destination escapes the configured root");
  }
}

function secureDirectoryReference(fd: number): string {
  if (process.platform !== "linux") {
    throw new Error(
      "Secure attachment downloads require the Linux container runtime",
    );
  }
  return `/proc/self/fd/${fd}`;
}

export function resolvePumbleFileDownloadUrl(
  config: BridgeConfig,
  candidate: string,
): string {
  if (!candidate) {
    throw new Error("Pumble file did not include a downloadable path.");
  }
  let base: URL;
  try {
    base = new URL(config.pumbleFileHostBaseUrl);
  } catch {
    throw new Error("Configured Pumble file base URL is invalid.");
  }
  if (base.protocol !== "https:") {
    throw new Error("Configured Pumble file base URL must use HTTPS.");
  }
  let fileUrl: URL;
  try {
    fileUrl = new URL(candidate);
  } catch {
    fileUrl = new URL(
      candidate.startsWith("/") ? candidate : `/${candidate}`,
      base,
    );
  }
  if (fileUrl.protocol !== "https:" || fileUrl.origin !== base.origin) {
    throw new Error(
      "Pumble file URL must be HTTPS on the configured file origin.",
    );
  }
  return fileUrl.toString();
}

async function writeResponseBody(
  response: Response,
  localPath: string,
  maxBytes: number,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Pumble file response did not include a readable body.");
  }

  let bytesSaved = 0;
  const handle = await open(localPath, "wx", 0o600);
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
        throw new Error(
          `File exceeded limit ${maxBytes} bytes while downloading.`,
        );
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
  const basename = path
    .basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return basename.slice(0, 160) || "pumble-file";
}
