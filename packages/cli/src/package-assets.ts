import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The only repository paths copied into the published runtime assets. */
export const CANONICAL_ASSET_PATHS = [
  "Dockerfile",
  ".dockerignore",
  "build",
  "entrypoint",
  "template",
  "packages/contracts",
  "packages/core",
  "packages/pumble-adapter",
] as const;

type PackageAssetRoot =
  | "packages/contracts"
  | "packages/core"
  | "packages/pumble-adapter";

/** Runtime files copied from each private package into the asset tree. */
export const PACKAGE_ASSET_PATHS: Record<PackageAssetRoot, readonly string[]> = {
  "packages/contracts": ["package.json", "package-lock.json", "src", "schemas"],
  "packages/core": ["package.json", "package-lock.json", "src"],
  "packages/pumble-adapter": ["package.json", "package-lock.json", "src"],
};

const EXCLUDED_NAMES: Record<string, true> = {
  ".git": true,
  ".lb": true,
  ".hg": true,
  ".svn": true,
  ".worktrees": true,
  worktrees: true,
  node_modules: true,
  dist: true,
  test: true,
  tests: true,
  __tests__: true,
  coverage: true,
  sessions: true,
  credentials: true,
  caches: true,
  cache: true,
  __pycache__: true,
  ".pytest_cache": true,
  "runtime.env": true,
  "child-registry.json": true,
};
const DATABASE_FILE = /\.(?:db|sqlite|sqlite3)(?:[-.]|$)/i;

/**
 * Copy the canonical runtime inputs into a package-local assets directory.
 * Source entries are lstat-checked, symlinks are rejected, and excluded
 * state is skipped so an npm package never captures local runtime data.
 */
export async function stagePackagedAssets(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error(`asset source root must be a real directory: ${source}`);
  }
  if (source === destination) {
    throw new Error(`asset destination must differ from source root: ${destination}`);
  }
  for (const assetPath of CANONICAL_ASSET_PATHS) {
    const sourcePath = resolve(source, assetPath);
    if (sourcePath === destination || isWithin(sourcePath, destination)) {
      throw new Error(`asset destination overlaps canonical source: ${destination}`);
    }
  }

  const existingDestination = await lstat(destination).catch(() => null);
  if (existingDestination?.isSymbolicLink()) {
    throw new Error(`asset destination must not be a symlink: ${destination}`);
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  try {
    for (const assetPath of CANONICAL_ASSET_PATHS) {
      if (isPackageAssetRoot(assetPath)) {
        const packageSource = join(source, assetPath);
        const packageDestination = join(destination, assetPath);
        await mkdir(packageDestination, { recursive: true });
        for (const relativePath of PACKAGE_ASSET_PATHS[assetPath]) {
          await copyAsset(
            join(packageSource, relativePath),
            join(packageDestination, relativePath),
            join(assetPath, relativePath),
          );
        }
      } else {
        await copyAsset(
          join(source, assetPath),
          join(destination, assetPath),
          assetPath,
        );
      }
    }
    await verifyAssetTree(destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Return true for names that can only represent local state or source tests. */
export function isExcludedAssetName(name: string): boolean {
  const lower = basename(name).toLowerCase();
  return EXCLUDED_NAMES[name] === true
    || EXCLUDED_NAMES[lower] === true
    || /^\.env(?:\.|$)/i.test(name)
    || DATABASE_FILE.test(name);
}

async function copyAsset(
  sourcePath: string,
  destinationPath: string,
  assetPath: string,
): Promise<void> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) throw new Error(`refusing to stage symlink: ${sourcePath}`);
  if (info.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = join(sourcePath, entry.name);
      const childAssetPath = join(assetPath, entry.name);
      const childInfo = await lstat(childPath);
      if (childInfo.isSymbolicLink()) {
        throw new Error(`refusing to stage symlink: ${childPath}`);
      }
      if (isExcludedAssetPath(childAssetPath)) continue;
      await copyAsset(childPath, join(destinationPath, entry.name), childAssetPath);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`cannot stage non-regular asset: ${sourcePath}`);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

async function verifyAssetTree(root: string): Promise<void> {
  const expectedTopLevel: Record<string, true> = {
    Dockerfile: true,
    ".dockerignore": true,
    build: true,
    entrypoint: true,
    template: true,
    packages: true,
  };
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (expectedTopLevel[entry.name] !== true) {
      throw new Error(`unexpected packaged asset: ${entry.name}`);
    }
  }
  for (const packageRoot of Object.keys(PACKAGE_ASSET_PATHS) as PackageAssetRoot[]) {
    const packagePath = join(root, packageRoot);
    const expected = Object.fromEntries(
      PACKAGE_ASSET_PATHS[packageRoot].map((path) => [path.split(sep)[0], true]),
    ) as Record<string, true>;
    const entries = await readdir(packagePath, { withFileTypes: true });
    for (const entry of entries) {
      if (expected[entry.name] !== true) {
        throw new Error(`unexpected packaged runtime file: ${join(packageRoot, entry.name)}`);
      }
    }
  }
  await verifyTree(root, "");
}

async function verifyTree(root: string, assetPath: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(root, entry.name);
    const childAssetPath = join(assetPath, entry.name);
    const info = await lstat(childPath);
    if (info.isSymbolicLink()) throw new Error(`packaged asset is a symlink: ${childAssetPath}`);
    if (isExcludedAssetPath(childAssetPath)) {
      throw new Error(`excluded state entered packaged assets: ${childAssetPath}`);
    }
    if (info.isDirectory()) {
      await verifyTree(childPath, childAssetPath);
    } else if (!info.isFile()) {
      throw new Error(`packaged asset is not a regular file: ${childAssetPath}`);
    }
  }
}

function isExcludedAssetPath(assetPath: string): boolean {
  const segments = assetPath.split(sep).filter(Boolean);
  for (const segment of segments) {
    if (isExcludedAssetName(segment)) return true;
  }
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === "packages" && segments[index + 1] === "cli") return true;
  }
  return false;
}

function isPackageAssetRoot(assetPath: string): assetPath is PackageAssetRoot {
  return Object.hasOwn(PACKAGE_ASSET_PATHS, assetPath);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ""
    && path !== ".."
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}
