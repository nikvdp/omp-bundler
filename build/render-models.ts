/**
 * Models template renderer.
 *
 * Shared catalog validation lives here so both the renderer and the
 * folder build script validate the same surface without duplication.
 * Exports (used by build/build-image.ts):
 *   - expand(tmpl): placeholder expansion against process.env
 *   - validate(parsed): rendered-catalog structural validation
 *   - PLACEHOLDER: env-placeholder regex
 *
 * Expands ${VAR} placeholders in a models.yml.tmpl against the process
 * environment, validates the rendered catalog, and writes models.yml.
 * Fails nonzero with named diagnostics on:
 *   - any placeholder whose env var is missing or empty
 *   - any unresolved ${...} surviving expansion
 *   - a rendered catalog missing a top-level providers object
 *   - any provider with a missing or empty models array
 *
 * Model metadata (ids, contextWindow, maxTokens, compat, …) is left
 * literal: only ${VAR} substitutions touch the text, and the raw expanded
 * text is written verbatim so comments and formatting survive.
 *
 * Usage:
 *   bun build/render-models.ts --input <tmpl> --output <out>
 *   MODELS_INPUT=<tmpl> MODELS_OUTPUT=<out> bun build/render-models.ts
 *
 * No external dependencies. Runs on Bun's built-in YAML parser.
 */

// ── arg parsing ────────────────────────────────────────────────────────

type Args = { input: string; output: string };

function parseArgs(argv: string[]): Args {
  let input = process.env.MODELS_INPUT ?? "";
  let output = process.env.MODELS_OUTPUT ?? "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--input" || a === "-i") {
      if (!next) die(`flag ${a} requires a path argument`);
      input = next;
      i++;
    } else if (a === "--output" || a === "-o") {
      if (!next) die(`flag ${a} requires a path argument`);
      output = next;
      i++;
    } else if (a.startsWith("--input=")) {
      input = a.slice("--input=".length);
    } else if (a.startsWith("--output=")) {
      output = a.slice("--output=".length);
    } else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      die(`unexpected argument: ${a}\n\n${usageText()}`);
    }
  }

  if (!input) input = "template/models.yml.tmpl";
  if (!output) output = "template/models.yml";

  return { input, output };
}

function usageText(): string {
  return [
    "usage: bun build/render-models.ts --input <tmpl> --output <out>",
    "       MODELS_INPUT=<tmpl> MODELS_OUTPUT=<out> bun build/render-models.ts",
  ].join("\n");
}

function usage(): void {
  console.error(usageText());
}

// ── fail loudly ────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`models-renderer: ${msg}`);
  process.exit(1);
}

function failAll(errors: string[]): never {
  console.error("models-renderer: refusing to render, fix the following:");
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

// ── placeholder expansion ──────────────────────────────────────────────

// Valid env-var names: uppercase letters, digits, underscore; must
// start with a letter or underscore. Matches ${ANTHROPIC_API_KEY},
// ${custom-provider_BASE_URL}, etc.
export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Generic braced token: any ${...} at all, including shell-style
// expansions (${VAR:-x}) and malformed names (${BAD-NAME}). The first
// pass replaces valid-name placeholders; anything left is caught here.
const SURVIVOR = /\$\{[^}]*\}/g;

export function expand(tmpl: string): { text: string; missing: string[]; survivors: string[] } {
  const missing = new Set<string>();

  // First pass: replace every ${VALID_NAME} with its env value. Names
  // with no env value are left in place and collected.
  const text = tmpl.replace(PLACEHOLDER, (_full, name: string) => {
    const val = process.env[name];
    if (val === undefined || val === "") {
      missing.add(name);
      return _full;
    }
    return val;
  });

  // Second pass: a generic scan for any surviving ${...}. This catches
  // shell-style expansions (${VAR:-x}) and malformed names (${BAD-NAME})
  // the first pass could not match. Valid-name placeholders left in
  // place because their env var was missing/empty are already in
  // `missing`, so skip them here to avoid double-reporting.
  const survivors = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SURVIVOR.source, "g");
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const name = new RegExp(PLACEHOLDER.source).exec(token)?.[1];
    if (name && missing.has(name)) continue;
    survivors.add(token);
  }

  return { text, missing: [...missing].sort(), survivors: [...survivors].sort() };
}

// ── validation ────────────────────────────────────────────────────────

type Model = Record<string, unknown>;
type Provider = { models?: unknown; [k: string]: unknown };
type Catalog = { providers?: Record<string, Provider> | null; [k: string]: unknown };

export function validate(parsed: unknown): string[] {
  const errors: string[] = [];

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push("rendered file is not a YAML mapping (top-level object expected)");
    return errors;
  }

  const catalog = parsed as Catalog;
  const providers = catalog.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    errors.push("missing top-level 'providers' object");
    return errors;
  }

  const entries = Object.entries(providers as Record<string, Provider>);
  if (entries.length === 0) {
    errors.push("'providers' object is empty, at least one provider required");
    return errors;
  }

  for (const [name, provider] of entries) {
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      errors.push(`provider '${name}' is not a mapping`);
      continue;
    }
    const models = provider.models;
    if (!Array.isArray(models)) {
      errors.push(`provider '${name}' has no 'models' array`);
      continue;
    }
    if (models.length === 0) {
      errors.push(`provider '${name}' has an empty 'models' array`);
      continue;
    }
    for (let i = 0; i < models.length; i++) {
      const model = models[i] as Model | null;
      if (typeof model !== "object" || model === null) {
        errors.push(`provider '${name}' model #${i + 1} is not a mapping`);
        continue;
      }
      if (!model.id || typeof model.id !== "string") {
        errors.push(`provider '${name}' model #${i + 1} missing string 'id'`);
      }
    }
  }

  return errors;
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { input, output } = parseArgs(process.argv.slice(2));

  let tmpl: string;
  try {
    tmpl = await Bun.file(input).text();
  } catch (e) {
    die(`cannot read input template '${input}': ${(e as Error).message}`);
  }

  if (tmpl.length === 0) die(`input template '${input}' is empty`);

  const { text: rendered, missing, survivors } = expand(tmpl);

  // Collect every expansion failure up front so a single run names
  // all offenders: missing/empty valid env vars plus any ${...} that
  // survived (shell-style expansions, malformed names, or valid
  // names left because their env var was unset).
  const expansionErrors = [
    ...missing.map((n) => `env var '${n}' is missing or empty`),
    ...survivors.map((t) => `unresolved placeholder '${t}' in template`),
  ];
  if (expansionErrors.length > 0) failAll(expansionErrors);

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(rendered);
  } catch (e) {
    die(`rendered template is not valid YAML: ${(e as Error).message}`);
  }

  const errors = validate(parsed);
  if (errors.length > 0) failAll(errors);

  try {
    await Bun.write(output, rendered);
  } catch (e) {
    die(`cannot write output '${output}': ${(e as Error).message}`);
  }

  console.error(`models-renderer: rendered ${output} from ${input}`);
}

if (import.meta.main) main();