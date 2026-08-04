import type { ParsedArguments } from "./types.ts";

export function optionString(
  args: ParsedArguments,
  name: string,
): string | undefined {
  const value = args.options[name.replace(/^--?/, "")];
  return typeof value === "string" ? value : undefined;
}

export function optionBoolean(
  args: ParsedArguments,
  name: string,
): boolean {
  return args.options[name.replace(/^--?/, "")] === true;
}
