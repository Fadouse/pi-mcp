import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize, truncateTail, type TruncationResult } from "@earendil-works/pi-coding-agent";
import type { McpToolDetails } from "./types.js";

type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface NormalizedMcpResult {
  content: PiContent[];
  details: McpToolDetails;
  isError: boolean;
  errorText?: string;
}

export interface McpTextOutput {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

export async function applyMcpTextOutputPolicy(
  content: string,
  identity: { serverName: string; remoteName: string },
  toolCallId: string,
  limits: { maxBytes: number; maxLines: number },
): Promise<McpTextOutput> {
  const truncation = truncateTail(content, {
    maxBytes: limits.maxBytes,
    maxLines: limits.maxLines,
  });
  if (!truncation.truncated) return { content: truncation.content, truncation };

  const fullOutputPath = await saveFullOutput(identity, toolCallId, content);
  return {
    content: truncation.content + formatTruncationNotice(content, truncation, fullOutputPath, limits.maxBytes),
    truncation,
    fullOutputPath,
  };
}

export async function normalizeMcpToolResult(
  result: unknown,
  identity: { serverName: string; remoteName: string; piName: string },
  toolCallId: string,
  limits: { maxBytes: number; maxLines: number },
): Promise<NormalizedMcpResult> {
  const value = isRecord(result) ? result : { toolResult: result };
  const rawBlocks = Array.isArray(value.content) ? value.content : [];
  const content: PiContent[] = [];
  const textParts: string[] = [];

  for (const block of rawBlocks) {
    if (!isRecord(block) || typeof block.type !== "string") {
      textParts.push(safeJson(block));
      continue;
    }
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") textParts.push(block.text);
        break;
      case "image":
        if (typeof block.data === "string" && typeof block.mimeType === "string") {
          content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        }
        break;
      case "audio":
        textParts.push(`[Audio content: ${String(block.mimeType ?? "unknown type")}, omitted from model context]`);
        break;
      case "resource": {
        const resource = block.resource;
        if (isRecord(resource)) {
          const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
          if (typeof resource.text === "string") textParts.push(`[Resource ${uri}]\n${resource.text}`);
          else if (typeof resource.blob === "string") {
            textParts.push(`[Binary resource ${uri}: ${String(resource.mimeType ?? "unknown type")}, ${formatSize(Buffer.byteLength(resource.blob, "base64"))}]`);
          }
        }
        break;
      }
      case "resource_link": {
        const uri = typeof block.uri === "string" ? block.uri : "unknown";
        const name = typeof block.name === "string" ? block.name : uri;
        const description = typeof block.description === "string" ? ` — ${block.description}` : "";
        textParts.push(`[Resource link: ${name} (${uri})${description}]`);
        break;
      }
      default:
        textParts.push(safeJson(block));
    }
  }

  const structuredContent = isRecord(value.structuredContent) ? value.structuredContent : undefined;
  if (textParts.length === 0 && content.length === 0) {
    if (structuredContent) textParts.push(safeJson(structuredContent, true));
    else if ("toolResult" in value) textParts.push(safeJson(value.toolResult, true));
    else textParts.push("MCP tool completed without content.");
  }

  const fullText = textParts.join("\n\n");
  const output = await applyMcpTextOutputPolicy(fullText, identity, toolCallId, limits);
  if (output.content) content.unshift({ type: "text", text: output.content });

  const details: McpToolDetails = {
    kind: "mcp-tool",
    serverName: identity.serverName,
    remoteToolName: identity.remoteName,
    piToolName: identity.piName,
    ...(structuredContent ? { structuredContent } : {}),
    ...(isRecord(value._meta) ? { meta: value._meta } : {}),
    ...(output.truncation.truncated ? { truncated: true, truncation: output.truncation } : {}),
    ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
  };
  const isError = value.isError === true;
  return {
    content,
    details,
    isError,
    ...(isError ? { errorText: output.content || "MCP server reported a tool error" } : {}),
  };
}

function formatTruncationNotice(
  fullText: string,
  truncation: ReturnType<typeof truncateTail>,
  fullOutputPath: string,
  maxBytes: number,
): string {
  const endLine = truncation.totalLines;
  const startLine = Math.max(1, endLine - truncation.outputLines + 1);
  if (truncation.lastLinePartial) {
    const lastLine = fullText.split("\n").at(-1) ?? "";
    return `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(Buffer.byteLength(lastLine))}). Full output: ${fullOutputPath}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }
  return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatOutputLimit(maxBytes)} limit). Full output: ${fullOutputPath}]`;
}

function formatOutputLimit(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024}KB` : formatSize(bytes);
}

async function saveFullOutput(
  identity: { serverName: string; remoteName: string },
  toolCallId: string,
  content: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const safe = `${identity.serverName}-${identity.remoteName}-${toolCallId}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const path = join(directory, `${safe}.txt`);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

function safeJson(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
