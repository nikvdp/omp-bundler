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
 * .dockerignore plus the build/, packages/contracts/, packages/core/,
 * packages/pumble-adapter/, and entrypoint/ trees.
 *
 * With --agents <dir>, each subdirectory's .omp/ is validated and
 * staged to agents/<agentId>/.omp so the image bakes per-agent
 * personalities at /agents/<agentId>/.omp/. The agents/ context
 * directory is always created (empty when --agents is absent) so the
 * Dockerfile COPY is unconditional. Only the .omp subtree is staged;
 * sibling working files in the agent folder are untouched.
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
 *   bun build/build-image.ts <agent-folder-path> <local-image-tag> [--agents <dir>]
 *
 * No external dependencies. Runs on Bun's built-in YAML parser and
 * node:fs/promises.
 */

import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expand, omitUnconfiguredProviders, validate } from "./render-models";

// ── arg parsing ────────────────────────────────────────────────────────

type Args = { folder: string; tag: string; agentsDir: string | null };

const USAGE = [
  "usage: bun build/build-image.ts <agent-folder-path> <local-image-tag> [--agents <dir>]",
  "Stages an ephemeral Docker context from <agent-folder-path> (copied as",
  "template/) plus the repo build/, packages/contracts/, packages/core/,",
  "packages/pumble-adapter/, and entrypoint/ trees, then runs `docker build",
  "-t <tag> <context>`. Validates required folder surfaces and the",
  "models.yml.tmpl catalog before invoking Docker. When --agents <dir> is",
  "given, each subdirectory's .omp/ is validated and staged to agents/<id>/.omp.",
].join("\n");

function fail(msg: string): never {
  console.error(`build-image: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  // Accept exactly two positionals plus an optional trailing --agents <dir>.
  // Any other flag, any other count, is rejected: the build surface stays
  // predictable and no silent flag-guessing creeps in.
  const positionals: string[] = [];
  let agentsDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agents") {
      if (agentsDir !== null) {
        console.error(USAGE);
        fail("duplicate --agents flag");
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        console.error(USAGE);
        fail("--agents requires a directory argument");
      }
      agentsDir = next;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(USAGE);
      fail(
        `unknown flag '${a}'; expected <agent-folder-path> <local-image-tag> [--agents <dir>]`,
      );
    }
    positionals.push(a);
  }
  if (positionals.length !== 2) {
    console.error(USAGE);
    fail(
      `expected exactly two positional arguments: <agent-folder-path> <local-image-tag>, got ${positionals.length}`,
    );
  }
  const [folder, tag] = positionals;
  return { folder, tag, agentsDir };
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
const OPTIONAL_DIRS = [
  "agents",
  "commands",
  "extensions",
  "skills",
  "tools",
] as const;

// Root files Docker needs at the context root to build.
const ROOT_FILES = ["Dockerfile", ".dockerignore"] as const;

// Repo runtime trees copied verbatim into the ephemeral context.
const RUNTIME_TREES = [
  "build",
  "packages/contracts",
  "packages/core",
  "packages/pumble-adapter",
  "entrypoint",
] as const;
const RUNTIME_IGNORED_DIRS = new Set(["node_modules", "dist"]);

// Agent identities are baked at /agents/<agentId>/.omp/ in the image and
// seeded to /data/agents/<agentId>/.omp at boot. The agentId is the folder
// name and must match this regex for every agent identity.
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Entries allowed inside an agent's .omp/ directory. These are the only
// per-agent discovery surfaces; anything else is rejected by name so a
// stray file never impersonates a surface. Shared catalog and state are
// global-only (live in template/ or /data), never per-agent.
const AGENT_OMP_ALLOWED: Record<string, true> = {
  "AGENTS.md": true,
  "config.yml": true,
  "settings.json": true,
  agents: true,
  commands: true,
  extensions: true,
  skills: true,
  tools: true,
};

// Names rejected inside an agent's .omp/ because they are global-only:
// the model catalog is shared (models.yml / models.yml.tmpl), session
// history is shared, and agent.db* is shared per-agent-process state.
const AGENT_OMP_GLOBAL_ONLY = [
  "models.yml",
  "models.yml.tmpl",
  "sessions",
] as const;
const AGENT_DB = /^agent\.db.*$/;

// An apiKey must be exactly one ${VALID_NAME} placeholder and nothing
// else: no literal secrets, no shell expansions, no partial embeddings.
const EXACT_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// True only for "no such file or directory". Permission errors, I/O
// errors, and anything else must not be swallowed as "absent".
function isEnoent(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";
}

// Docker must never receive a symlink from staged input. lstat and readdir
// inspect each directory entry without resolving it first.
async function assertNoSymlinks(
  path: string,
  ignoredDirectoryNames: ReadonlySet<string> = new Set(),
): Promise<Stats> {
  const s = await lstat(path);
  if (s.isSymbolicLink()) {
    throw new Error(`refusing to stage symlink: ${path}`);
  }
  if (s.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (ignoredDirectoryNames.has(entry)) continue;
      await assertNoSymlinks(join(path, entry), ignoredDirectoryNames);
    }
  }
  return s;
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
    const path = join(folder, name);
    try {
      await assertNoSymlinks(path);
    } catch (e) {
      if (!isEnoent(e)) {
        fail(`cannot inspect required file '${path}': ${(e as Error).message}`);
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
type Catalog = {
  providers?: Record<string, Provider> | null;
  [k: string]: unknown;
};

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

async function stageContext(repoRoot: string, folder: string): Promise<string> {
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
        s = await assertNoSymlinks(src);
      } catch (e) {
        if (!isEnoent(e)) {
          throw new Error(
            `cannot inspect optional dir '${src}': ${(e as Error).message}`,
          );
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
        throw new Error(
          `cannot access repo root file '${src}': ${(e as Error).message}`,
        );
      }
      await copyFile(src, join(ctx, name));
    }

    // Repo runtime trees: build/, packages/contracts/, packages/core/,
    // packages/pumble-adapter/, entrypoint/.
    for (const tree of RUNTIME_TREES) {
      const src = join(repoRoot, tree);
      try {
        await assertNoSymlinks(src, RUNTIME_IGNORED_DIRS);
      } catch (e) {
        if (isEnoent(e))
          throw new Error(`repo runtime tree not found: ${tree}`);
        throw new Error(
          `cannot inspect repo runtime tree '${src}': ${(e as Error).message}`,
        );
      }
      await cp(src, join(ctx, tree), {
        recursive: true,
        dereference: false,
        filter: (candidate) =>
          candidate === src || !RUNTIME_IGNORED_DIRS.has(basename(candidate)),
      });
    }
  } catch (e) {
    await rm(ctx, { recursive: true, force: true });
    throw e;
  }
  return ctx;
}

// ── per-agent .omp staging ─────────────────────────────────────────────

/**
 * Validate and stage agent identity folders from --agents <dir> into the
 * ephemeral context at agents/<agentId>/.omp. The agents/ directory is
 * ALWAYS created (empty when --agents is absent) so the Dockerfile COPY
 * is unconditional.
 *
 * For each subdirectory of <dir> (plain files are ignored):
 *   - name must match the agentId regex;
 *   - must contain a .omp directory;
 *   - the agent folder is symlink-checked (RUNTIME_IGNORED_DIRS);
 *   - inside .omp, only the whitelisted per-agent surfaces are allowed;
 *     models.yml(.tmpl), sessions, and agent.db* are rejected as
 *     global-only.
 * Only the .omp subtree is staged; sibling working files are untouched.
 */
async function stageAgents(ctx: string, agentsDir: string | null): Promise<void> {
  const agentsRoot = join(ctx, "agents");
  await mkdir(agentsRoot, { recursive: true });
  if (agentsDir === null) return;

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (e) {
    if (isEnoent(e)) fail(`--agents directory not found: ${agentsDir}`);
    fail(`cannot read --agents directory '${agentsDir}': ${(e as Error).message}`);
  }

  for (const name of entries) {
    const agentPath = join(agentsDir, name);
    let s: Stats;
    try {
      s = await lstat(agentPath);
    } catch (e) {
      if (isEnoent(e)) continue; // raced away; skip
      fail(`cannot inspect --agents entry '${agentPath}': ${(e as Error).message}`);
    }
    // Plain files are ignored: only subdirectories are agent identities.
    if (!s.isDirectory()) continue;

    if (!AGENT_ID.test(name)) {
      fail(
        `--agents: invalid agent id '${name}' (must match ^[a-z0-9][a-z0-9_-]{0,63}$)`,
      );
    }

    const ompPath = join(agentPath, ".omp");
    let ompStat: Stats;
    try {
      ompStat = await stat(ompPath);
    } catch (e) {
      if (isEnoent(e)) {
        fail(`--agents: agent '${name}' is missing a .omp directory (${ompPath})`);
      }
      fail(`cannot stat agent .omp '${ompPath}': ${(e as Error).message}`);
    }
    if (!ompStat.isDirectory()) {
      fail(`--agents: agent '${name}' .omp is not a directory: ${ompPath}`);
    }

    // Symlink-check the whole agent folder (respecting ignored dirs) so
    // Docker never receives a link from staged agent input.
    try {
      await assertNoSymlinks(agentPath, RUNTIME_IGNORED_DIRS);
    } catch (e) {
      fail(`--agents: agent '${name}': ${(e as Error).message}`);
    }

    // Whitelist the .omp contents by name. Global-only surfaces and any
    // unknown name are rejected with a clear error.
    let ompEntries: string[];
    try {
      ompEntries = await readdir(ompPath);
    } catch (e) {
      fail(`cannot read agent .omp '${ompPath}': ${(e as Error).message}`);
    }
    for (const entry of ompEntries) {
      if ((AGENT_OMP_GLOBAL_ONLY as readonly string[]).includes(entry)) {
        fail(
          `--agents: agent '${name}': '${entry}' is global-only and not allowed inside an agent .omp (lives in the shared template/)`,
        );
      }
      if (AGENT_DB.test(entry)) {
        fail(
          `--agents: agent '${name}': '${entry}' is global-only state (agent.db*) and not allowed inside an agent .omp`,
        );
      }
      if (!AGENT_OMP_ALLOWED[entry]) {
        fail(
          `--agents: agent '${name}': '.omp/${entry}' is not an allowed agent surface; allowed: ${Object.keys(AGENT_OMP_ALLOWED).join(", ")}`,
        );
      }
    }

    // Stage ONLY the .omp subtree. dereference:false preserves on-disk
    // shape; assertNoSymlinks already guaranteed no links are present.
    const dest = join(agentsRoot, name, ".omp");
    await mkdir(join(agentsRoot, name), { recursive: true });
    await cp(ompPath, dest, { recursive: true, dereference: false });
  }
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
  const { folder, tag, agentsDir } = parseArgs(process.argv.slice(2));

  if (!tag) fail("local image tag must be non-empty");

  // realpath resolves to an absolute path; if the folder does not
  // exist (ENOENT), fall back to the raw path so assertFolder names
  // it. Other errors (permission denied, I/O) fail loudly.
  let folderAbs: string;
  try {
    folderAbs = await realpath(folder);
  } catch (e) {
    if (!isEnoent(e)) {
      fail(
        `cannot resolve agent folder path '${folder}': ${(e as Error).message}`,
      );
    }
    folderAbs = folder;
  }
  await assertFolder(folderAbs);
  await assertRequiredFiles(folderAbs);

  // Resolve --agents dir the same way as the agent folder: realpath to
  // absolute, falling back to the raw path on ENOENT so stageAgents can
  // name it. null means --agents was not given.
  let agentsDirAbs: string | null = null;
  if (agentsDir !== null) {
    try {
      agentsDirAbs = await realpath(agentsDir);
    } catch (e) {
      if (!isEnoent(e)) {
        fail(
          `cannot resolve --agents path '${agentsDir}': ${(e as Error).message}`,
        );
      }
      agentsDirAbs = agentsDir;
    }
  }

  // Validate the catalog surface before touching Docker.
  const tmplText = await Bun.file(join(folderAbs, "models.yml.tmpl")).text();
  if (tmplText.length === 0) {
    fail("models.yml.tmpl is empty");
  }
  // Prepare the catalog exactly as container-time renderer does: omit
  // wholly unconfigured optional providers before checking placeholders.
  let preparedTemplate = tmplText;
  let partialProviders: string[] = [];
  try {
    const prepared = omitUnconfiguredProviders(tmplText);
    preparedTemplate = prepared.text;
    partialProviders = prepared.partial;
  } catch (e) {
    fail(`cannot prepare optional model providers: ${(e as Error).message}`);
  }
  const { survivors } = expand(preparedTemplate);
  const catalogErrors = validateCatalog(preparedTemplate);
  const allErrors = [
    ...partialProviders,
    ...survivors.map((t) => `unresolved placeholder '${t}' in models.yml.tmpl`),
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
  let buildError: string | null = null;
  try {
    ctx = await stageContext(repoRoot, folderAbs);
    await stageAgents(ctx, agentsDirAbs);
    console.error(`build-image: staged context at ${ctx}`);
    console.error(`build-image: docker build -t ${tag} <context>`);
    dockerCode = await dockerBuild(tag, ctx);
    if (dockerCode !== 0) {
      console.error(`build-image: docker build exited ${dockerCode}`);
    } else {
      console.error(`build-image: built ${tag}`);
    }
  } catch (e) {
    // Capture the error but do NOT process.exit here: the finally
    // block must clean the staged context first, then we exit below.
    buildError = `build failed: ${(e as Error).message}`;
  } finally {
    if (ctx !== null) await rm(ctx, { recursive: true, force: true });
  }
  if (buildError !== null) fail(buildError);
  if (dockerCode !== 0) process.exit(dockerCode);
}

main();