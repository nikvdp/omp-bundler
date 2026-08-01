import type { ParsedArguments } from "./types.ts";

export type OptionType = "boolean" | "string";

export interface OptionSpec {
  readonly name: string;
  readonly alias?: string;
  readonly type?: OptionType;
  readonly required?: boolean;
  readonly default?: string | boolean;
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

const BOOLEAN_OPTIONS: Record<string, true> = {
  help: true,
  version: true,
  "dry-run": true,
  yes: true,
};
const SHORT_OPTION_NAMES: Record<string, string> = { h: "help", v: "version" };

/**
 * Parse one command's argv without assigning meaning to its subgrammar.
 * Unknown long options are accepted so each command module can validate its
 * own flags while sharing quoting, aliases, and missing-value handling.
 */
export function parseArgs(
  argv: readonly string[],
  specs: readonly OptionSpec[] = [],
): ParsedArguments {
  const byName = new Map<string, OptionSpec>();
  const byAlias = new Map<string, OptionSpec>();
  for (const spec of specs) {
    const name = normalizeOptionName(spec.name);
    if (byName.has(name) || byAlias.has(name)) throw new ArgumentError(`duplicate option spec: --${name}`);
    byName.set(name, { ...spec, name });
    if (spec.alias) {
      const alias = normalizeOptionName(spec.alias);
      if (byAlias.has(alias) || byName.has(alias)) throw new ArgumentError(`duplicate option alias: -${alias}`);
      byAlias.set(alias, { ...spec, name });
    }
  }

  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let parseOptions = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }
    if (!parseOptions || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const parsed = splitOption(token);
    const spec = parsed.short
      ? byAlias.get(parsed.name)
      : byName.get(parsed.name);
    const optionName = spec?.name ?? (parsed.short ? SHORT_OPTION_NAMES[parsed.name] ?? parsed.name : parsed.name);
    const optionType = spec?.type ?? (BOOLEAN_OPTIONS[optionName] ? "boolean" : undefined);
    let value: string | boolean;

    if (parsed.inlineValue !== undefined) {
      if (optionType === "boolean") {
        value = parseBoolean(parsed.inlineValue, token);
      } else {
        value = parsed.inlineValue;
      }
    } else if (optionType === "boolean") {
      value = true;
    } else {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        if (spec?.type === "string") {
          throw new ArgumentError(`--${optionName} requires a value`);
        }
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }

    if (optionName in options) {
      throw new ArgumentError(`duplicate option: --${optionName}`);
    }
    options[optionName] = value;
  }

  for (const spec of specs) {
    const name = normalizeOptionName(spec.name);
    if (!(name in options) && spec.default !== undefined) options[name] = spec.default;
    if (spec.required && !(name in options)) {
      throw new ArgumentError(`missing required option: --${name}`);
    }
  }

  return { positionals, options };
}

export function optionString(
  args: ParsedArguments,
  name: string,
): string | undefined {
  const value = args.options[normalizeOptionName(name)];
  return typeof value === "string" ? value : undefined;
}

export function optionBoolean(
  args: ParsedArguments,
  name: string,
): boolean {
  return args.options[normalizeOptionName(name)] === true;
}

function normalizeOptionName(name: string): string {
  const normalized = name.replace(/^--?/, "");
  if (!normalized || /\s/.test(normalized)) {
    throw new ArgumentError(`invalid option name: ${name}`);
  }
  return normalized;
}

function splitOption(token: string): {
  short: boolean;
  name: string;
  inlineValue?: string;
} {
  const short = token.startsWith("-") && !token.startsWith("--");
  const body = token.slice(short ? 1 : 2);
  if (!body) throw new ArgumentError(`invalid option: ${token}`);
  const equals = body.indexOf("=");
  if (equals < 0) return { short, name: body };
  const name = body.slice(0, equals);
  if (!name) throw new ArgumentError(`invalid option: ${token}`);
  return { short, name, inlineValue: body.slice(equals + 1) };
}

function parseBoolean(value: string, token: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ArgumentError(`${token} expects true or false`);
}
