import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { EMBEDDED_ASSETS_STUB, generateEmbeddedAssetsModule } from "./embedded-assets.ts";
import { stagePackagedAssets } from "../src/package-assets.ts";

/**
 * Build the standalone `omp-bundler` binary.
 *
 * The binary has no filesystem for its modules, so it carries the Dockerfile,
 * entrypoint, build scripts, and every runtime package inside the executable
 * and extracts them at run time. Those assets must therefore be staged and
 * embedded *before* the compile step: compiling against the committed stub
 * produces a binary that silently ships no assets, and the failure only
 * surfaces later as a Docker build reading someone else's cached files.
 *
 * The stub is restored afterwards so the generated module never lingers as a
 * working-tree change.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const assetsRoot = join(packageRoot, "assets");
const embeddedAssetsPath = join(packageRoot, "src", "embedded-assets.generated.ts");
const outfile = process.argv[2] ?? join(packageRoot, "omp-bundler");

await stagePackagedAssets(repositoryRoot, assetsRoot);
await generateEmbeddedAssetsModule(assetsRoot, embeddedAssetsPath);

try {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "--compile",
      "--outfile",
      outfile,
      join(packageRoot, "src", "cli.ts"),
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`failed to compile the CLI binary (exit ${result.exitCode})`);
  }
} finally {
  await writeFile(embeddedAssetsPath, EMBEDDED_ASSETS_STUB);
}

console.log(`compiled ${outfile}`);
