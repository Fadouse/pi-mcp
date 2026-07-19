import { Type, type TSchema } from "typebox";

const STRIP_KEYS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

export function normalizeMcpInputSchema(input: unknown): TSchema {
  if (!isRecord(input)) throw new Error("inputSchema must be an object");
  const root = structuredClone(input);
  const definitions = collectDefinitions(root);
  const normalized = normalizeNode(root, definitions, new Set(), 0);
  if (!isRecord(normalized)) throw new Error("inputSchema did not normalize to an object");

  normalized.type = "object";
  if (!isRecord(normalized.properties)) normalized.properties = {};
  delete normalized.$defs;
  delete normalized.definitions;
  return Type.Unsafe(normalized);
}

export function schemaSearchText(schema: unknown): string {
  const parts: string[] = [];
  collectSearchText(schema, parts, new Set(), 0);
  return parts.join(" ");
}

function collectDefinitions(root: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const containerName of ["$defs", "definitions"]) {
    const container = root[containerName];
    if (!isRecord(container)) continue;
    for (const [name, value] of Object.entries(container)) {
      result.set(`#/${containerName}/${escapeJsonPointer(name)}`, value);
      result.set(`#/${containerName}/${name}`, value);
    }
  }
  return result;
}

function normalizeNode(
  value: unknown,
  definitions: Map<string, unknown>,
  resolving: Set<string>,
  depth: number,
): unknown {
  if (depth > 64) throw new Error("inputSchema exceeds maximum nesting depth");
  if (Array.isArray(value)) return value.map((item) => normalizeNode(item, definitions, resolving, depth + 1));
  if (!isRecord(value)) return value;

  const reference = typeof value.$ref === "string" ? value.$ref : undefined;
  if (reference?.startsWith("#/")) {
    const target = definitions.get(reference);
    if (target === undefined) throw new Error(`unsupported or missing schema reference ${reference}`);
    if (resolving.has(reference)) throw new Error(`recursive schema reference ${reference} is not supported`);
    const nextResolving = new Set(resolving).add(reference);
    const resolved = normalizeNode(target, definitions, nextResolving, depth + 1);
    if (!isRecord(resolved)) return resolved;
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    const normalizedSiblings = normalizeNode(siblings, definitions, resolving, depth + 1);
    return isRecord(normalizedSiblings) ? { ...resolved, ...normalizedSiblings } : resolved;
  }
  if (reference) throw new Error(`external schema reference ${reference} is not supported`);

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (STRIP_KEYS.has(key) || key === "$defs" || key === "definitions") continue;
    output[key] = normalizeNode(child, definitions, resolving, depth + 1);
  }
  return output;
}

function collectSearchText(value: unknown, parts: string[], seen: Set<unknown>, depth: number): void {
  if (depth > 32 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSearchText(item, parts, seen, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description" || key === "title" || key === "name") {
      if (typeof child === "string") parts.push(child);
      continue;
    }
    if (key === "properties" && isRecord(child)) {
      parts.push(...Object.keys(child));
    }
    collectSearchText(child, parts, seen, depth + 1);
  }
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
