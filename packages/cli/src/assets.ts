import { access } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a file shipped with this npm package, independent of process.cwd(). */
export function resolvePackagedAsset(
  assetPath: string,
  moduleUrl = import.meta.url,
): string {
  if (!assetPath || isAbsolute(assetPath)) {
    throw new Error(`asset path must be a non-empty relative path: ${assetPath || "<empty>"}`);
  }
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), "..");
  const assetsRoot = resolve(packageRoot, "assets");
  const resolved = resolve(assetsRoot, assetPath);
  const escaped = relative(assetsRoot, resolved);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`asset path escapes packaged assets: ${assetPath}`);
  }
  return resolved;
}

export async function requirePackagedAsset(
  assetPath: string,
  moduleUrl = import.meta.url,
): Promise<string> {
  const resolved = resolvePackagedAsset(assetPath, moduleUrl);
  try {
    await access(resolved);
  } catch (error) {
    throw new Error(`packaged asset not found: ${assetPath} (${resolved})`);
  }
  return resolved;
}
