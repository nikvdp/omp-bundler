import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EMBEDDED_ASSETS_STUB, generateEmbeddedAssetsModule } from "./embedded-assets.ts";
import { stagePackagedAssets } from "../src/package-assets.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const assetsRoot = join(packageRoot, "assets");
const distRoot = join(packageRoot, "dist");

await stagePackagedAssets(repositoryRoot, assetsRoot);
await stageTuiBinary(repositoryRoot, assetsRoot);
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

async function stageTuiBinary(repositoryRoot: string, assetsRoot: string): Promise<void> {
  const target = `${process.platform}-${process.arch}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-bundler-tui-"));
  const binaryPath = join(temporaryRoot, process.platform === "win32" ? "omp-tui.exe" : "omp-tui");
  try {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
    const build = Bun.spawn([
      "go",
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${packageJson.version}`,
      "-o",
      binaryPath,
      ".",
    ], {
      cwd: join(repositoryRoot, "tools", "omp-tui"),
      stdout: "inherit",
      stderr: "pipe",
    });
    const exitCode = await build.exited;
    if (exitCode !== 0) {
      throw new Error(`failed to build internal TUI: ${await new Response(build.stderr).text()}`);
    }
    const destination = join(assetsRoot, "tools", "omp-tui");
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, `${target}.base64`),
      (await readFile(binaryPath)).toString("base64"),
      "utf8",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
