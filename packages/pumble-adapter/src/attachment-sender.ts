import crypto from "node:crypto";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import type { PumbleApi } from "./pumble-api.js";
import type { ResolvedTarget, AttachmentSender } from "./pumble-renderer.js";
import type { WorkspaceAttachment } from "@omp-bundler/contracts/shared";

/**
 * AttachmentSender that delivers workspace output attachments as expiring
 * HMAC-signed download links posted into the Pumble target thread.
 *
 * For each attachment:
 *   1. Validates the attachment path is workspace-relative and resolves to
 *      a path inside the shared workspace root (traversal containment).
 *   2. Generates an expiring signed download URL: GET /download?p=<rel>&exp=<ts>&sig=<hex>
 *      where the signature is HMAC-SHA256(coreSharedSecret, path|expiry) over
 *      the exact query values. The link expires after downloadLinkTtlSeconds.
 *   3. Posts the link as a message in the target thread (threaded when the
 *      target has a threadRootId).
 *
 * The download route verifies expiry and signature and serves only regular
 * files under the workspace root. No secret appears in logs, URLs (beyond the
 * HMAC digest), or request bodies.
 */
export class PumbleAttachmentSender implements AttachmentSender {
  constructor(
    private readonly config: BridgeConfig,
    private readonly pumble: PumbleApi,
    private readonly appKey: string,
    private readonly botToken: string,
  ) {}

  async send(target: ResolvedTarget, attachment: WorkspaceAttachment): Promise<void> {
    this.resolveWorkspacePath(attachment.path);
    const label = attachment.name || path.basename(attachment.path);
    const link = this.signDownloadLink(attachment.path);
    const message = `Attachment: ${label}\n${link}`;
    await this.pumble.sendMessage(
      this.appKey,
      this.botToken,
      target.channelId,
      message,
      target.threadRootId,
    );
  }

  /**
   * Resolve a workspace-relative attachment path to an absolute filesystem
   * path, verifying it stays inside the workspace root. Throws on traversal
   * escape, absolute paths, or parent-directory references.
   */
  resolveWorkspacePath(workspacePath: string): string {
    return PumbleAttachmentSender.resolveWorkspacePathStatic(this.config, workspacePath);
  }

  /**
   * Static workspace path containment check. The workspace root is the
   * parent of pumbleFileDir (the shared volume root). A workspace-relative
   * path that resolves outside this root is rejected.
   */
  static resolveWorkspacePathStatic(config: BridgeConfig, workspacePath: string): string {
    if (!workspacePath || workspacePath.length === 0) {
      throw new Error("attachment path is empty");
    }
    const workspaceRoot = path.dirname(config.pumbleFileDir);
    const resolved = path.resolve(workspaceRoot, workspacePath);
    const normalizedRoot = path.resolve(workspaceRoot);
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
      throw new Error(`attachment path "${workspacePath}" escapes workspace root`);
    }
    return resolved;
  }

  /**
   * Generate an expiring HMAC-signed download URL for a workspace-relative
   * path. The signature covers the exact path and expiry timestamp so a
   * tampered query or expired link is rejected.
   */
  signDownloadLink(workspacePath: string): string {
    if (!this.config.publicBaseUrl) {
      throw new Error(
        "publicBaseUrl is required to generate download links but is not configured",
      );
    }
    if (!this.config.coreSharedSecret) {
      throw new Error(
        "coreSharedSecret is required to sign download links but is not configured",
      );
    }
    const expiry = Math.floor(Date.now() / 1000) + this.config.downloadLinkTtlSeconds;
    const signature = PumbleAttachmentSender.computeSignature(
      this.config.coreSharedSecret,
      workspacePath,
      expiry,
    );
    const params = new URLSearchParams({
      p: workspacePath,
      exp: String(expiry),
      sig: signature,
    });
    return `${this.config.publicBaseUrl}/download?${params.toString()}`;
  }

  /**
   * Verify a download link signature and expiry. Returns the verified
   * workspace-relative path, or throws on mismatch/expiry.
   */
  static verifyDownloadLink(
    config: BridgeConfig,
    queryPath: string,
    queryExp: string,
    querySig: string,
  ): string {
    if (!queryPath || !queryExp || !querySig) {
      throw new Error("download link missing required query parameters");
    }
    const expiry = Number(queryExp);
    if (!Number.isFinite(expiry)) {
      throw new Error("download link has invalid expiry");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > expiry) {
      throw new Error("download link has expired");
    }
    const expected = PumbleAttachmentSender.computeSignature(
      config.coreSharedSecret,
      queryPath,
      expiry,
    );
    const provided = Buffer.from(querySig, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (provided.length !== expectedBuf.length) {
      throw new Error("download link signature mismatch");
    }
    if (!crypto.timingSafeEqual(provided, expectedBuf)) {
      throw new Error("download link signature mismatch");
    }
    return queryPath;
  }

  private static computeSignature(
    secret: string,
    workspacePath: string,
    expiry: number,
  ): string {
    const message = `${workspacePath}|${expiry}`;
    return crypto
      .createHmac("sha256", secret)
      .update(message, "utf8")
      .digest("hex");
  }
}
