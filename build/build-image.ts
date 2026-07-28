/**
 * Folder-to-local-image build script.
 *
 * Takes an agent-folder path and an explicit local image tag, validates
 * the required config/context/model-template surfaces, stages an
 * ephemeral self-contained Docker context, runs `docker build`, and
 * propagates Docker's exit code. The ephemeral context is removed in a
 * finally block; neither the repo nor the source folder is mutated.
 *
 * Only the documented agent-folder surface is staged into template/:
 * the required files plus optional discovery directories. Local state
 * (rendered models.yml, agent.db, sessions, caches, credentials) is
 * never copied. The context root also gets the repo Dockerfile and
 * .dockerignore plus the build/, packages/core/, and entrypoint/ trees.
 *
 * Catalog structural validation is reused from build/render-models.ts
 * (exported `validate`) so the build script and the container-time
 * renderer enforce the same surface; no duplicate catalog validator.
 *
 * No build args or model secrets are passed to Docker: provider
 * credentials resolve at container start from runtime env against the
 * ${VAR} placeholders in models.yml.tmpl, exactly as the renderer does.
 * This script never prints secrets, build args, or env values.
 *
 * Usage:
 *   bun build/build-image.ts <agent-folder-path> <local-image-tag>
 *
 * No external dependencies. Runs on Bun's built-in YAML parser and
 * node:fs/promises.
 */

import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand, validate } from "./render-models";

// ── arg parsing ────────────────────────────────────────────────────────

type Args = { folder: string; tag: string };

const USAGE = [
  "usage: bun build/build-image.ts <agent-folder-path> <local-image-tag>",
  "",
  "Stages an ephemeral Docker context from <agent-folder-path> (copied as",
  "template/) plus the repo build/, packages/core/, and entrypoint/ trees,",
  "then runs `docker build -t <tag> <context>`. Validates required folder",
  "surfaces and the models.yml.tmpl catalog before invoking Docker.",
].join("\n");

function fail(msg: string): never {
  console.error(`build-image: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const rest = argv.filter((a) => !a.startsWith("--"));
  if (rest.length !== 2) {
    console.error(USAGE);
    fail("expected exactly two arguments: <agent-folder-path> <local-image-tag>");
  }
  return { folder: rest[0], tag: rest[1] };
}

// The agent folder is installed as $HOME/.omp/agent in the image, so
// these are the load-bearing discovery surfaces the build guarantees.
const REQUIRED_FILES = ["AGENTS.md", "config.yml", "models.yml.tmpl"] as const;

// Optional agent-folder surfaces documented in docs/agent-folder.md.
// Each, if present, MUST be a directory; a file with one of these
// names is rejected so a stray file never impersonates a discovery
// surface. Whitelisting (not whole-folder copy) keeps local state out
// of the image: rendered models.yml, agent.db, sessions, caches, and
// credentials never reach the context.
const OPTIONAL_DIRS = ["agents", "commands", "extensions", "skills", "tools"] as const;

// Root files Docker needs at the context root to build.
const ROOT_FILES = ["Dockerfile", ".dockerignore"] as const;

// Repo runtime trees copied verbatim into the ephemeral context.
const RUNTIME_TREES = ["build", "packages/core", "entrypoint"] as const;

// An apiKey must be exactly one ${VALID_NAME} placeholder and nothing
// else: no literal secrets, no shell expansions, no partial embeddings.
const EXACT_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// True only for "no such file or directory". Permission errors, I/O
// errors, and anything else must not be swallowed as "absent".
function isEnoent(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";
}

async function assertFolder(path: string): Promise<void> {
  let s: Stats;
  try {
    s = await stat(path);
  } catch (e) {
    if (isEnoent(e)) fail(`agent folder not found: ${path}`);
    fail(`cannot stat agent folder '${path}': ${(e as Error).message}`);
  }
  if (!s.isDirectory()) fail(`agent folder path is not a directory: ${path}`);
}

async function assertRequiredFiles(folder: string): Promise<void> {
  const missing: string[] = [];
  for (const name of REQUIRED_FILES) {
    try {
      await access(join(folder, name));
    } catch (e) {
      if (!isEnoent(e)) {
        fail(`cannot access required file '${join(folder, name)}': ${(e as Error).message}`);
      }
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    fail(
      `agent folder missing required file(s): ${missing.join(", ")} ` +
        `(looked in ${folder})`,
    );
  }
}

// ── catalog + apiKey validation (reuses render-models exports) ─────────

type Provider = { apiKey?: unknown; models?: unknown; [k: string]: unknown };
type Catalog = { providers?: Record<string, Provider> | null; [k: string]: unknown };

/**
 * Validate the models.yml.tmpl catalog surface *before* Docker is
 * invoked, so a malformed agent folder fails fast with named errors
 * instead of producing a broken image.
 *
 * Structural validation (providers object, non-empty providers, each
 * provider has a non-empty models array, each model has a string id)
 * is delegated to the shared `validate` from render-models.ts.
 *
 * apiKey policy: every provider `apiKey`, if present, must be exactly
 * one ${VALID_NAME} placeholder. A literal secret string, a shell-style
 * expansion (${VAR:-x}), or a malformed name is rejected; secrets must
 * never be baked into the template or the build.
 */
function validateCatalog(tmplText: string): string[] {
  const errors: string[] = [];

  // The template carries ${VAR} placeholders as literal string values,
  // so it is valid YAML and `validate` can check its structure directly.
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(tmplText);
  } catch (e) {
    errors.push(`models.yml.tmpl is not valid YAML: ${(e as Error).message}`);
    return errors;
  }

  // Shared structural validation: same rules the renderer enforces.
  errors.push(...validate(parsed));

  const catalog = parsed as Catalog;
  const providers = catalog?.providers;
  if (typeof providers !== "object" || providers === null) return errors;

  for (const [name, provider] of Object.entries(providers)) {
    if (typeof provider !== "object" || provider === null) continue;
    const apiKey = (provider as Provider).apiKey;
    if (apiKey === undefined) continue; // absent is allowed
    if (typeof apiKey !== "string") {
      errors.push(`provider '${name}' apiKey is not a string`);
      continue;
    }
    if (!EXACT_PLACEHOLDER.test(apiKey)) {
      errors.push(
        `provider '${name}' apiKey must be an exact \${ENV_NAME} placeholder, ` +
          `got a non-placeholder value (literal secrets are not allowed)`,
      );
    }
  }

  return errors;
}

// ── ephemeral context staging ──────────────────────────────────────────

async function stageContext(
  repoRoot: string,
  folder: string,
): Promise<string> {
  const ctx = await mkdtemp(join(tmpdir(), "omp-bundler-build-"));
  const tmplDir = join(ctx, "template");
  try {
    await mkdir(tmplDir, { recursive: true });

    // Copy the required files into template/. These are guaranteed
    // present by assertRequiredFiles, so a missing one is a hard error.
    for (const name of REQUIRED_FILES) {
      await copyFile(join(folder, name), join(tmplDir, name));
    }

    // Copy optional discovery directories if present. Each must be a
    // directory; a stray file with a reserved name is rejected. This
    // whitelist keeps local state (rendered models.yml, agent.db,
    // sessions, caches, credentials) out of the image.
    for (const name of OPTIONAL_DIRS) {
      const src = join(folder, name);
      let s: Stats;
      try {
        s = await stat(src);
      } catch (e) {
        if (!isEnoent(e)) {
          throw new Error(`cannot stat optional dir '${src}': ${(e as Error).message}`);
        }
        continue; // optional, absent is fine
      }
      if (!s.isDirectory()) {
        throw new Error(
          `agent folder '${name}' is not a directory; refusing to stage`,
        );
      }
      await cp(src, join(tmplDir, name), {
        recursive: true,
        dereference: true,
      });
    }

    // Root files Docker needs at the context root.
    for (const name of ROOT_FILES) {
      const src = join(repoRoot, name);
      try {
        await access(src);
      } catch (e) {
        if (isEnoent(e)) throw new Error(`repo root file not found: ${name}`);
        throw new Error(`cannot access repo root file '${src}': ${(e as Error).message}`);
      }
      await copyFile(src, join(ctx, name));
    }

    // Repo runtime trees: build/, packages/core/, entrypoint/.
    for (const tree of RUNTIME_TREES) {
      const src = join(repoRoot, tree);
      try {
        await access(src);
      } catch (e) {
        if (isEnoent(e)) throw new Error(`repo runtime tree not found: ${tree}`);
        throw new Error(`cannot access repo runtime tree '${src}': ${(e as Error).message}`);
      }
      await cp(src, join(ctx, tree), {
        recursive: true,
        dereference: true,
      });
    }
  } catch (e) {
    await rm(ctx, { recursive: true, force: true });
    throw e;
  }
  return ctx;
}

// ── docker build ───────────────────────────────────────────────────────

/**
 * Run `docker build -t <tag> <context>`. Streams Docker's own stdout/
 * stderr through to the caller; this script adds no args and prints no
 * secrets. Resolves with Docker's exit code.
 */
function dockerBuild(tag: string, context: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn("docker", ["build", "-t", tag, context], {
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
  return promise;
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { folder, tag } = parseArgs(process.argv.slice(2));

  if (!tag) fail("local image tag must be non-empty");

  // realpath resolves to an absolute path; if the folder does not
  // exist (ENOENT), fall back to the raw path so assertFolder names
  // it. Other errors (permission denied, I/O) fail loudly.
  let folderAbs: string;
  try {
    folderAbs = await realpath(folder);
  } catch (e) {
    if (!isEnoent(e)) {
      fail(`cannot resolve agent folder path '${folder}': ${(e as Error).message}`);
    }
    folderAbs = folder;
  }
  await assertFolder(folderAbs);
  await assertRequiredFiles(folderAbs);

  // Validate the catalog surface before touching Docker.
  const tmplText = await Bun.file(join(folderAbs, "models.yml.tmpl")).text();
  if (tmplText.length === 0) {
    fail("models.yml.tmpl is empty");
  }
  // Confirm placeholder expansion would resolve cleanly against the
  // current environment too; the renderer runs at container start with
  // the same env, so surface unresolved placeholders now. We do NOT
  // require the env vars to be set here (they are runtime secrets);
  // we only reject survivors that are not valid-name placeholders.
  const { survivors } = expand(tmplText);
  const catalogErrors = validateCatalog(tmplText);
  const allErrors = [
    ...survivors.map(
      (t) => `unresolved placeholder '${t}' in models.yml.tmpl`,
    ),
    ...catalogErrors,
  ];
  if (allErrors.length > 0) {
    console.error("build-image: refusing to build, fix the following:");
    for (const e of allErrors) console.error(`  • ${e}`);
    process.exit(1);
  }

  // Repo root is the parent of build/.
  const repoRoot = join(import.meta.dir, "..");

  let ctx: string | null = null;
  let dockerCode = 0;
  try {
    ctx = await stageContext(repoRoot, folderAbs);
    console.error(`build-image: staged context at ${ctx}`);
    console.error(`build-image: docker build -t ${tag} <context>`);
    dockerCode = await dockerBuild(tag, ctx);
    if (dockerCode !== 0) {
      console.error(`build-image: docker build exited ${dockerCode}`);
    } else {
      console.error(`build-image: built ${tag}`);
    }
  } catch (e) {
    fail(`build failed: ${(e as Error).message}`);
  } finally {
    if (ctx !== null) await rm(ctx, { recursive: true, force: true });
  }
  if (dockerCode !== 0) process.exit(dockerCode);
}

main();