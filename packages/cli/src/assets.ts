import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID, EMBEDDED_ASSETS } from "./embedded-assets.generated.ts";

/** Resolve the package root that owns `moduleUrl`: the directory above `assets/`. */
function packageRootFor(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

let materializedRoot: string | undefined;

/**
 * Extract every embedded asset to a real cache directory.
 *
 * A standalone compiled binary has no real filesystem for its modules:
 * `import.meta.url` is a virtual `file:///$bunfs/...` path. The binary carries
 * its assets inside the executable (bundled from
 * `embedded-assets.generated.ts` during prepack), so the first asset read
 * materializes them under `~/.cache/omp-bundler/assets` — Docker builds need
 * real files on disk. A rebuilt binary with a different build ID replaces the
 * stale tree.
 */
async function materializedAssetsRoot(): Promise<string> {
  if (materializedRoot) return materializedRoot;
  const root = join(homedir(), ".cache", "omp-bundler", "assets");
  const stampPath = join(root, ".stamp");
  let stamp = "";
  try {
    stamp = await readFile(stampPath, "utf8");
  } catch {
    // Missing stamp: extract below.
  }
  // BUILD_ID is a digest of the embedded assets, so a stamp mismatch means the
  // cache holds a different build's files. "stub" is the committed placeholder
  // shared by every pre-prepack build: it identifies no particular content, so
  // a cache stamped with it is never reusable and is always re-extracted.
  if (stamp !== BUILD_ID || BUILD_ID === "stub") {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    for (const [assetPath, content] of Object.entries(EMBEDDED_ASSETS)) {
      const target = join(root, assetPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(stampPath, BUILD_ID);
  }
  materializedRoot = root;
  return root;
}

/** Resolve a file shipped with this npm package, independent of process.cwd(). */
export async function resolvePackagedAsset(
  assetPath: string,
  moduleUrl = import.meta.url,
): Promise<string> {
  if (!assetPath || isAbsolute(assetPath)) {
    throw new Error(`asset path must be a non-empty relative path: ${assetPath || "<empty>"}`);
  }
  // A compiled binary resolves assets from the embedded copy, extracted to a
  // real cache directory; the npm package and source tree keep them on disk
  // next to the module.
  const assetsRoot = moduleUrl.startsWith("file:///$bunfs/")
    ? await materializedAssetsRoot()
    : resolve(packageRootFor(moduleUrl), "assets");
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
  const resolved = await resolvePackagedAsset(assetPath, moduleUrl);
  try {
    await access(resolved);
  } catch (error) {
    throw new Error(`packaged asset not found: ${assetPath} (${resolved})`);
  }
  return resolved;
}
