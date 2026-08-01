import { readFile, writeFile } from "node:fs/promises";
import type { Scalar, YamlValue } from "./types.ts";

export class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

interface YamlLine {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
}

export function parseYaml(source: string): YamlValue {
  const lines = source
    .split(/\r?\n/)
    .map((raw, index) => {
      if (/\t/.test(raw)) throw new YamlError(`tabs are not supported at line ${index + 1}`);
      const withoutComment = stripComment(raw).replace(/\s+$/, "");
      if (!withoutComment.trim() || withoutComment.trim() === "---" || withoutComment.trim() === "...") {
        return null;
      }
      const indent = withoutComment.length - withoutComment.trimStart().length;
      return { number: index + 1, indent, text: withoutComment.slice(indent) } satisfies YamlLine;
    })
    .filter((line): line is YamlLine => line !== null);

  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new YamlError(`root must start at column 1 (line ${lines[0].number})`);
  const parsed = parseBlock(lines, 0, lines[0].indent);
  if (parsed.index !== lines.length) {
    throw new YamlError(`unexpected indentation at line ${lines[parsed.index].number}`);
  }
  return parsed.value;
}

export async function readYamlFile<T extends YamlValue = YamlValue>(path: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read YAML file '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseYaml(source) as T;
  } catch (error) {
    if (error instanceof YamlError) throw new Error(`${path}: ${error.message}`);
    throw error;
  }
}

export function stringifyYaml(value: YamlValue): string {
  return `${writeYamlValue(value, 0, undefined).join("\n")}\n`;
}

export async function writeYamlFile(path: string, value: YamlValue): Promise<void> {
  await writeFile(path, stringifyYaml(value), "utf8");
}

function parseBlock(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { value: YamlValue; index: number } {
  if (lines[start].text.startsWith("- ") || lines[start].text === "-") {
    return parseSequence(lines, start, indent);
  }
  const object: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(`unexpected indentation at line ${line.number}`);
    }
    if (line.text.startsWith("- ") || line.text === "-") break;
    const pair = splitPair(line.text);
    if (!pair) throw new YamlError(`expected 'key: value' at line ${line.number}`);
    if (pair.key in object) throw new YamlError(`duplicate key '${pair.key}' at line ${line.number}`);
    if (pair.value.length > 0) {
      object[pair.key] = parseScalar(pair.value, line.number);
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      object[pair.key] = {};
      index += 1;
      continue;
    }
    const child = parseBlock(lines, index + 1, next.indent);
    object[pair.key] = child.value;
    index = child.index;
  }
  return { value: object, index };
}

function parseSequence(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { value: YamlValue; index: number } {
  const values: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent || (!line.text.startsWith("- ") && line.text !== "-")) {
      throw new YamlError(`expected list item at line ${line.number}`);
    }
    const item = line.text === "-" ? "" : line.text.slice(2).trim();
    if (!item) {
      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        values.push(null);
        index += 1;
      } else {
        const child = parseBlock(lines, index + 1, next.indent);
        values.push(child.value);
        index = child.index;
      }
      continue;
    }

    const pair = splitPair(item);
    if (!pair) {
      values.push(parseScalar(item, line.number));
      index += 1;
      continue;
    }

    const object: Record<string, YamlValue> = {};
    object[pair.key] = pair.value.length > 0 ? parseScalar(pair.value, line.number) : {};
    index += 1;
    const next = lines[index];
    if (!next || next.indent <= indent) {
      values.push(object);
      continue;
    }
    const childIndent = next.indent;
    if (pair.value.length === 0) {
      const child = parseBlock(lines, index, childIndent);
      object[pair.key] = child.value;
      index = child.index;
    }
    if (index < lines.length && lines[index].indent === childIndent && !lines[index].text.startsWith("- ")) {
      const rest = parseBlock(lines, index, childIndent);
      if (typeof rest.value !== "object" || rest.value === null || Array.isArray(rest.value)) {
        throw new YamlError(`list item continuation must be a mapping at line ${lines[index].number}`);
      }
      for (const [key, value] of Object.entries(rest.value)) {
        if (key in object) throw new YamlError(`duplicate key '${key}' at line ${lines[index].number}`);
        object[key] = value;
      }
      index = rest.index;
    }
    values.push(object);
  }
  return { value: values, index };
}

function splitPair(text: string): { key: string; value: string } | null {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && character === ":" && (index + 1 === text.length || /\s/.test(text[index + 1]))) {
      const key = text.slice(0, index).trim();
      if (!key) return null;
      return { key: unquote(key), value: text.slice(index + 1).trim() };
    }
  }
  return null;
}

function parseScalar(text: string, line: number): YamlValue {
  if (!text) return null;
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      return JSON.parse(text) as YamlValue;
    } catch {
      if (text.startsWith("[")) {
        return splitInline(text.slice(1, -1)).map((part) => parseScalar(part, line));
      }
      const result: Record<string, YamlValue> = {};
      for (const part of splitInline(text.slice(1, -1))) {
        const pair = splitPair(part);
        if (!pair) throw new YamlError(`invalid inline mapping at line ${line}`);
        result[pair.key] = parseScalar(pair.value, line);
      }
      return result;
    }
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unquote(text);
  }
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^(?:null|~)$/i.test(text)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function splitInline(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote ?? character;
    } else if (!quote && (character === "[" || character === "{")) {
      depth += 1;
    } else if (!quote && (character === "]" || character === "}")) {
      depth -= 1;
    } else if (!quote && depth === 0 && character === ",") {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new YamlError(`invalid quoted scalar: ${value}`);
    }
  }
  return value;
}

function stripComment(value: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? null : quote ?? character;
    } else if (!quote && character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function writeYamlValue(value: YamlValue, indent: number, key: string | undefined): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${key === undefined ? "[]" : `${key}: []`}`];
    const output: string[] = key === undefined ? [] : [`${prefix}${key}:`];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          output.push(`${" ".repeat(indent + (key === undefined ? 0 : 2))}- {}`);
        } else {
          const [firstKey, firstValue] = entries[0];
          const itemIndent = indent + (key === undefined ? 0 : 2);
          const firstLines = writeYamlValue(firstValue, itemIndent + 2, firstKey);
          output.push(`${" ".repeat(itemIndent)}- ${firstLines[0].trimStart()}`);
          output.push(...firstLines.slice(1));
          for (const [entryKey, entryValue] of entries.slice(1)) {
            output.push(...writeYamlValue(entryValue, itemIndent + 2, entryKey));
          }
        }
      } else if (Array.isArray(item)) {
        const itemIndent = indent + (key === undefined ? 0 : 2);
        if (item.length === 0) {
          output.push(`${" ".repeat(itemIndent)}- []`);
        } else {
          output.push(`${" ".repeat(itemIndent)}-`);
          output.push(...writeYamlValue(item, itemIndent + 2, undefined));
        }
      } else {
        output.push(`${" ".repeat(indent + (key === undefined ? 0 : 2))}- ${formatScalar(item)}`);
      }
    }
    return output;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}${key === undefined ? "{}" : `${key}: {}`}`];
    const output: string[] = key === undefined ? [] : [`${prefix}${key}:`];
    const childIndent = indent + (key === undefined ? 0 : 2);
    for (const [entryKey, entryValue] of entries) output.push(...writeYamlValue(entryValue, childIndent, entryKey));
    return output;
  }
  return [`${prefix}${key === undefined ? formatScalar(value) : `${key}: ${formatScalar(value)}`}`];
}

function formatScalar(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}
