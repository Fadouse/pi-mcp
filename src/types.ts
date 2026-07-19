import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  options?: McpOptions;
}

export interface McpOptions {
  searchLimit?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  includeServerInstructions?: boolean;
}

interface McpServerConfigBase {
  description?: string;
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  alwaysActiveTools?: string[];
  includeInstructions?: boolean;
  supportsParallelToolCalls?: boolean;
}

export interface StdioServerConfig extends McpServerConfigBase {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
  headers?: never;
}

export interface HttpServerConfig extends McpServerConfigBase {
  url: string;
  headers?: Record<string, string>;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface LoadedMcpConfig {
  servers: Map<string, ResolvedServerConfig>;
  options: Required<McpOptions>;
  files: string[];
  warnings: string[];
}

export interface ResolvedServerConfig {
  name: string;
  sourcePath: string;
  config: McpServerConfig;
}

export type ServerStatus = "idle" | "connecting" | "ready" | "failed" | "closed";

export interface ServerState {
  name: string;
  sourcePath: string;
  status: ServerStatus;
  client?: Client;
  transport?: Transport;
  tools: Tool[];
  instructions?: string;
  serverInfo?: { name: string; version: string };
  error?: string;
  stderr?: string;
}

export interface McpToolRecord {
  id: string;
  serverName: string;
  remoteName: string;
  piName: string;
  label: string;
  description: string;
  serverDescription?: string;
  tool: Tool;
  searchText: string;
  alwaysActive: boolean;
}

export interface McpToolDetails {
  kind: "mcp-tool";
  serverName: string;
  remoteToolName: string;
  piToolName: string;
  structuredContent?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  truncated?: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export interface McpActiveDetails {
  kind: "mcp-active";
  serverName: string;
  toolCount: number;
}

export interface McpSearchDetails {
  kind: "mcp-search";
  serverName: string;
  query: string;
  matches: string[];
  added: string[];
}

export type McpStateEntry =
  | { action: "reset" }
  | { action: "set"; activeToolNames: string[] };
