import { createHash } from "node:crypto";

const MAX_TOOL_NAME_BYTES = 64;
const PREFIX = "mcp_";

export function createMcpToolName(
  serverName: string,
  remoteToolName: string,
  used: Map<string, string>,
): string {
  const identity = `${serverName}\0${remoteToolName}`;
  const server = sanitizePart(serverName);
  const tool = sanitizePart(remoteToolName);
  let candidate = fitUtf8(`${PREFIX}${server}_${tool}`, MAX_TOOL_NAME_BYTES);

  const existing = used.get(candidate);
  if (existing === undefined || existing === identity) {
    used.set(candidate, identity);
    return candidate;
  }

  const suffix = `_${shortHash(identity)}`;
  candidate = `${fitUtf8(`${PREFIX}${server}_${tool}`, MAX_TOOL_NAME_BYTES - Buffer.byteLength(suffix))}${suffix}`;
  let attempt = 1;
  while (used.has(candidate) && used.get(candidate) !== identity) {
    const retrySuffix = `_${shortHash(`${identity}\0${attempt}`)}`;
    candidate = `${fitUtf8(`${PREFIX}${server}_${tool}`, MAX_TOOL_NAME_BYTES - Buffer.byteLength(retrySuffix))}${retrySuffix}`;
    attempt += 1;
  }
  used.set(candidate, identity);
  return candidate;
}

export function sanitizePart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

export function fitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    if (Buffer.byteLength(output) + Buffer.byteLength(char) > maxBytes) break;
    output += char;
  }
  return output.replace(/_+$/g, "") || "tool";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}
