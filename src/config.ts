import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  LoadedMcpConfig,
  McpConfigFile,
  McpOptions,
  McpServerConfig,
  ResolvedServerConfig,
} from "./types.js";

const DEFAULT_OPTIONS: Required<McpOptions> = {
  searchLimit: 3,
  maxOutputBytes: 50 * 1024,
  maxOutputLines: 2000,
  includeServerInstructions: false,
};

const SERVER_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export interface LoadConfigOptions {
  cwd: string;
  configDirName: string;
  projectTrusted: boolean;
  agentDir?: string;
}

export async function loadMcpConfig(options: LoadConfigOptions): Promise<LoadedMcpConfig> {
  const agentDir = options.agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(homedir(), ".pi", "agent");
  const candidates = [join(agentDir, "mcp.json")];
  if (options.projectTrusted) {
    candidates.push(join(options.cwd, options.configDirName, "mcp.json"));
  }

  const servers = new Map<string, ResolvedServerConfig>();
  const files: string[] = [];
  const warnings: string[] = [];
  let mergedOptions: Required<McpOptions> = { ...DEFAULT_OPTIONS };

  for (const path of candidates) {
    const parsed = await readConfigFile(path, warnings);
    if (!parsed) continue;
    files.push(path);
    mergedOptions = mergeOptions(mergedOptions, parsed.options, path, warnings);

    for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
      // A minimal project override can disable an inherited user server without
      // repeating its transport configuration.
      if (isRecord(config) && config.enabled === false) {
        servers.delete(name);
        continue;
      }
      const errors = validateServer(name, config);
      if (errors.length > 0) {
        warnings.push(`${path}: MCP server ${JSON.stringify(name)}: ${errors.join("; ")}`);
        continue;
      }
      servers.set(name, { name, sourcePath: path, config });
    }
  }

  return { servers, options: mergedOptions, files, warnings };
}

async function readConfigFile(path: string, warnings: string[]): Promise<McpConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    warnings.push(`${path}: ${errorMessage(error)}`);
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("top level must be an object");
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
      throw new Error("mcpServers must be an object");
    }
    return parsed as McpConfigFile;
  } catch (error) {
    warnings.push(`${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

function validateServer(name: string, value: unknown): string[] {
  const errors: string[] = [];
  if (!SERVER_NAME_RE.test(name)) errors.push("invalid server name");
  if (!isRecord(value)) return [...errors, "configuration must be an object"];

  const command = value.command;
  const url = value.url;
  const hasCommand = command !== undefined;
  const hasUrl = url !== undefined;
  if (hasCommand && hasUrl) {
    errors.push("command and url are mutually exclusive");
  } else if (!hasCommand && !hasUrl) {
    errors.push("set either command (stdio) or url (Streamable HTTP)");
  }
  if (hasCommand && typeof command !== "string") errors.push("command must be a string");
  if (hasUrl && typeof url !== "string") errors.push("url must be a string");
  if (typeof command === "string" && command.trim() === "") errors.push("command must not be empty");
  if (typeof command === "string" && value.headers !== undefined) errors.push("headers is only valid for HTTP servers");
  if (typeof url === "string" && (value.args !== undefined || value.env !== undefined || value.cwd !== undefined)) {
    errors.push("args, env, and cwd are only valid for stdio servers");
  }
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("url must use http or https");
      }
    } catch {
      errors.push("url is invalid");
    }
  }

  if (value.description !== undefined) {
    if (typeof value.description !== "string") errors.push("description must be a string");
    else if (value.description.trim() === "") errors.push("description must not be empty");
  }
  checkStringArray(value, "args", errors);
  checkStringArray(value, "enabledTools", errors);
  checkStringArray(value, "disabledTools", errors);
  checkStringArray(value, "alwaysActiveTools", errors);
  checkStringRecord(value, "env", errors);
  checkStringRecord(value, "headers", errors);
  checkPositiveInteger(value, "startupTimeoutMs", errors);
  checkPositiveInteger(value, "toolTimeoutMs", errors);
  if (value.cwd !== undefined && typeof value.cwd !== "string") errors.push("cwd must be a string");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") errors.push("enabled must be boolean");
  if (value.includeInstructions !== undefined && typeof value.includeInstructions !== "boolean") {
    errors.push("includeInstructions must be boolean");
  }
  if (value.supportsParallelToolCalls !== undefined && typeof value.supportsParallelToolCalls !== "boolean") {
    errors.push("supportsParallelToolCalls must be boolean");
  }
  return errors;
}

function mergeOptions(
  current: Required<McpOptions>,
  value: unknown,
  path: string,
  warnings: string[],
): Required<McpOptions> {
  if (value === undefined) return current;
  if (!isRecord(value)) {
    warnings.push(`${path}: options must be an object`);
    return current;
  }
  const next = { ...current };
  for (const field of ["searchLimit", "maxOutputBytes", "maxOutputLines"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (!Number.isInteger(candidate) || (candidate as number) <= 0) {
      warnings.push(`${path}: options.${field} must be a positive integer`);
      continue;
    }
    next[field] = candidate as number;
  }
  if (typeof value.includeServerInstructions === "boolean") {
    next.includeServerInstructions = value.includeServerInstructions;
  } else if (value.includeServerInstructions !== undefined) {
    warnings.push(`${path}: options.includeServerInstructions must be boolean`);
  }
  next.searchLimit = Math.min(next.searchLimit, 10);
  return next;
}

export function resolveServerCwd(config: McpServerConfig, sessionCwd: string): string {
  if (!("command" in config) || !config.cwd) return sessionCwd;
  return isAbsolute(config.cwd) ? config.cwd : resolve(sessionCwd, config.cwd);
}

export function expandConfigValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) throw new Error(`environment variable ${name} is not set`);
    return replacement;
  });
}

export function expandStringRecord(
  values: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, expandConfigValue(value, env)]));
}

function checkStringArray(value: Record<string, unknown>, key: string, errors: string[]): void {
  const candidate = value[key];
  if (candidate !== undefined && (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string"))) {
    errors.push(`${key} must be an array of strings`);
  }
}

function checkStringRecord(value: Record<string, unknown>, key: string, errors: string[]): void {
  const candidate = value[key];
  if (candidate !== undefined && (!isRecord(candidate) || Object.values(candidate).some((item) => typeof item !== "string"))) {
    errors.push(`${key} must be an object of strings`);
  }
}

function checkPositiveInteger(value: Record<string, unknown>, key: string, errors: string[]): void {
  const candidate = value[key];
  if (candidate !== undefined && (!Number.isInteger(candidate) || (candidate as number) <= 0)) {
    errors.push(`${key} must be a positive integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
