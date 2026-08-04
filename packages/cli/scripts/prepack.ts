import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, writeFile } from "node:fs/promises";
import { EMBEDDED_ASSETS_STUB, generateEmbeddedAssetsModule } from "./embedded-assets.ts";
import { stagePackagedAssets } from "../src/package-assets.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const assetsRoot = join(packageRoot, "assets");
const distRoot = join(packageRoot, "dist");

await stagePackagedAssets(repositoryRoot, assetsRoot);
const embeddedAssetsPath = join(packageRoot, "src", "embedded-assets.generated.ts");
await generateEmbeddedAssetsModule(assetsRoot, embeddedAssetsPath);
await rm(distRoot, { recursive: true, force: true });

try {
  const result = await Bun.build({
    entrypoints: [join(packageRoot, "src", "cli.ts")],
    outdir: distRoot,
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build CLI${details ? `:\n${details}` : ""}`);
  }
} finally {
  await writeFile(embeddedAssetsPath, EMBEDDED_ASSETS_STUB);
}

