import { isAbsolute, relative, resolve, sep } from "node:path";

export const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_PATTERN.test(value);
}

export function assertSafeIdentifier(
  value: string,
  label = "identifier",
): string {
  if (!isSafeIdentifier(value)) {
    throw new Error(
      `${label} '${value}' is unsafe; use 1-64 lowercase letters, numbers, '-' or '_' and start with a letter or number`,
    );
  }
  return value;
}

/** Resolve a user path while preventing lexical traversal outside root. */
export function resolveInside(root: string, child: string): string {
  if (!child || isAbsolute(child)) {
    throw new Error(`path must be a non-empty relative path: ${child || "<empty>"}`);
  }
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const escaped = relative(resolvedRoot, resolvedChild);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`path escapes project root: ${child}`);
  }
  return resolvedChild;
}

export function assertSafeRelativePath(value: string, label = "path"): string {
  if (!value || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.split("/").some((segment) => segment === "")
  ) {
    throw new Error(`${label} is unsafe: ${value}`);
  }
  return value;
}
