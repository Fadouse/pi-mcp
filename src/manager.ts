import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  expandConfigValue,
  expandStringRecord,
  resolveServerCwd,
} from "./config.js";
import type {
  LoadedMcpConfig,
  ResolvedServerConfig,
  ServerState,
} from "./types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 16_000;

export type InventoryChangedHandler = (server: ServerState) => void | Promise<void>;

export class McpManager {
  readonly states = new Map<string, ServerState>();
  private readonly startup = new Map<string, Promise<void>>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly loadedConfig: LoadedMcpConfig,
    private readonly cwd: string,
    private readonly onInventoryChanged: InventoryChangedHandler,
  ) {
    for (const server of loadedConfig.servers.values()) {
      this.states.set(server.name, {
        name: server.name,
        sourcePath: server.sourcePath,
        status: "idle",
        tools: [],
      });
    }
  }

  start(): void {
    for (const server of this.loadedConfig.servers.values()) {
      const promise = this.connectServer(server).catch(() => undefined);
      this.startup.set(server.name, promise);
    }
  }

  async waitForStartup(signal?: AbortSignal): Promise<void> {
    const all = Promise.allSettled(this.startup.values()).then(() => undefined);
    if (!signal) return all;
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await Promise.race([
      all,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    ]);
  }

  get readyCount(): number {
    return [...this.states.values()].filter((state) => state.status === "ready").length;
  }

  get pendingCount(): number {
    return [...this.states.values()].filter((state) => state.status === "connecting").length;
  }

  async callTool(
    serverName: string,
    remoteToolName: string,
    argumentsValue: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: number, total?: number, message?: string) => void;
    },
  ) {
    const state = this.states.get(serverName);
    if (!state?.client || state.status !== "ready") {
      throw new Error(`MCP server ${serverName} is not ready${state?.error ? `: ${state.error}` : ""}`);
    }
    const config = this.loadedConfig.servers.get(serverName)?.config;
    const timeout = config?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    return state.client.callTool(
      { name: remoteToolName, arguments: argumentsValue },
      undefined,
      {
        timeout,
        maxTotalTimeout: timeout,
        resetTimeoutOnProgress: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress
          ? {
              onprogress: (notification: { progress: number; total?: number; message?: string }) => {
                options.onProgress?.(notification.progress, notification.total, notification.message);
              },
            }
          : {}),
      },
    );
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const clients = [...this.states.values()].flatMap((state) => state.client ? [state.client] : []);
    await Promise.allSettled(clients.map((client) => client.close()));
    for (const state of this.states.values()) state.status = "closed";
  }

  private async connectServer(server: ResolvedServerConfig): Promise<void> {
    const state = this.states.get(server.name);
    if (!state) return;
    state.status = "connecting";
    state.error = undefined;

    try {
      const transport = this.createTransport(server, state);
      const client = new Client(
        { name: "pi-mcp", version: "0.1.0" },
        { capabilities: {} },
      );
      state.client = client;
      state.transport = transport;
      client.onerror = (error) => {
        state.error = error.message;
      };
      client.onclose = () => {
        if (!this.closing && state.status !== "failed") {
          state.status = "failed";
          state.error = state.error ?? "connection closed";
          void this.onInventoryChanged(state);
        }
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.queueRefresh(server.name);
      });

      const timeout = server.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
      await client.connect(transport, { timeout, maxTotalTimeout: timeout });
      if (this.closing) {
        await client.close();
        return;
      }
      state.instructions = client.getInstructions();
      state.serverInfo = client.getServerVersion();
      state.tools = client.getServerCapabilities()?.tools
        ? await listAllTools(client, timeout)
        : [];
      state.tools = filterTools(state.tools, server.config);
      state.status = "ready";
      state.error = undefined;
      await this.onInventoryChanged(state);
    } catch (error) {
      state.status = "failed";
      state.error = errorMessage(error);
      try {
        await state.client?.close();
      } catch {
        // Best-effort teardown after failed initialization.
      }
      await this.onInventoryChanged(state);
      throw error;
    }
  }

  private createTransport(server: ResolvedServerConfig, state: ServerState): Transport {
    const config = server.config;
    if (typeof config.command === "string") {
      const env = {
        ...getDefaultEnvironment(),
        ...expandStringRecord(config.env),
      };
      const transport = new StdioClientTransport({
        command: expandConfigValue(config.command),
        args: (config.args ?? []).map((arg) => expandConfigValue(arg)),
        env,
        cwd: resolveServerCwd(config, this.cwd),
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        state.stderr = `${state.stderr ?? ""}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
      });
      return transport;
    }

    const headers = expandStringRecord(config.headers);
    return new StreamableHTTPClientTransport(new URL(expandConfigValue(config.url)), {
      requestInit: { headers },
    });
  }

  private queueRefresh(serverName: string): Promise<void> {
    const existing = this.refreshes.get(serverName);
    if (existing) return existing;
    const refresh = this.refreshTools(serverName).finally(() => {
      if (this.refreshes.get(serverName) === refresh) this.refreshes.delete(serverName);
    });
    this.refreshes.set(serverName, refresh);
    return refresh;
  }

  private async refreshTools(serverName: string): Promise<void> {
    const state = this.states.get(serverName);
    const resolved = this.loadedConfig.servers.get(serverName);
    if (!state?.client || !resolved || state.status !== "ready") return;
    try {
      const timeout = resolved.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      state.tools = filterTools(await listAllTools(state.client, timeout), resolved.config);
      state.error = undefined;
      await this.onInventoryChanged(state);
    } catch (error) {
      state.error = `tool refresh failed: ${errorMessage(error)}`;
      await this.onInventoryChanged(state);
    }
  }
}

async function listAllTools(client: Client, timeout: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout,
      maxTotalTimeout: timeout,
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("tools/list returned a duplicate cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return tools;
}

function filterTools(tools: Tool[], config: ResolvedServerConfig["config"]): Tool[] {
  const enabled = config.enabledTools ? new Set(config.enabledTools) : undefined;
  const disabled = new Set(config.disabledTools ?? []);
  return tools.filter((tool) => {
    if (enabled && !enabled.has(tool.name)) return false;
    if (disabled.has(tool.name)) return false;
    return isModelVisible(tool);
  });
}

function isModelVisible(tool: Tool): boolean {
  const meta = tool._meta;
  if (!meta || typeof meta !== "object") return true;
  const ui = meta.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return true;
  const visibility = (ui as Record<string, unknown>).visibility;
  if (!Array.isArray(visibility)) return true;
  return visibility.includes("model");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
