import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.js";
import { McpManager } from "./manager.js";
import { createMcpToolName } from "./names.js";
import { normalizeMcpToolResult } from "./result.js";
import { normalizeMcpInputSchema, schemaSearchText } from "./schema.js";
import { McpToolSearchIndex } from "./search.js";
import type {
  LoadedMcpConfig,
  McpSearchDetails,
  McpStateEntry,
  McpToolDetails,
  McpToolRecord,
} from "./types.js";
import { showMcpDashboard } from "./ui.js";

const SEARCH_TOOL_NAME = "mcp_search";
const STATE_ENTRY_TYPE = "pi-mcp-state";
const STATUS_KEY = "20-pi-mcp";
const LEGACY_STATUS_KEYS = ["pi-mcp", "pi-mcp-tools"] as const;
const RESULT_PREVIEW_LINES = 5;

interface McpRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

const SEARCH_SCHEMA = Type.Object({
  query: Type.String({ description: "Capability or task to find MCP tools for" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

export default function piMcpExtension(pi: ExtensionAPI) {
  let manager: McpManager | undefined;
  let loadedConfig: LoadedMcpConfig | undefined;
  let sessionContext: ExtensionContext | undefined;
  let generation = 0;
  const searchIndex = new McpToolSearchIndex();
  const records = new Map<string, McpToolRecord>();
  const identityToName = new Map<string, string>();
  const usedNames = new Map<string, string>();
  const registeredNames = new Set<string>();
  const schemaErrors = new Map<string, string>();
  const shownInstructions = new Set<string>();

  pi.registerTool<typeof SEARCH_SCHEMA, McpSearchDetails>({
    name: SEARCH_TOOL_NAME,
    label: "MCP Search",
    description: "Search configured MCP tools by capability and enable the best matches for the next model response.",
    promptSnippet: "Search and enable configured MCP tools by capability",
    parameters: SEARCH_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      const currentManager = manager;
      const config = loadedConfig;
      if (!currentManager || !config || config.servers.size === 0) {
        return searchResult(params.query, [], [], "No MCP servers are configured.");
      }

      if (currentManager.pendingCount > 0) {
        onUpdate?.({
          content: [{ type: "text", text: `Connecting to MCP servers (${currentManager.readyCount}/${config.servers.size} ready)…` }],
          details: { kind: "mcp-search", query: params.query, matches: [], added: [] },
        });
        await currentManager.waitForStartup(signal);
      }

      const limit = Math.min(params.limit ?? config.options.searchLimit, 10);
      const matches = searchIndex.search(params.query, limit);
      const matchedNames = matches.map((record) => record.piName);
      const active = pi.getActiveTools();
      const added = matchedNames.filter((name) => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);

      const lines = matchedNames.length > 0
        ? [added.length > 0 ? `Loaded MCP tools: ${added.join(", ")}` : `Matching MCP tools already active: ${matchedNames.join(", ")}`]
        : [`No MCP tools matched: ${params.query}`];
      appendRelevantInstructions(lines, matches, config);
      const failed = [...currentManager.states.values()].filter((state) => state.status === "failed");
      if (failed.length > 0) lines.push(`Unavailable servers: ${failed.map((state) => state.name).join(", ")}`);
      return searchResult(params.query, matchedNames, added, lines.join("\n"));
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("mcp_search "))}${theme.fg("muted", args.query)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(theme.fg(isPartial ? "warning" : "success", text), 0, 0);
    },
  });

  pi.registerCommand("mcp", {
    description: "Open the MCP control center or run an MCP management action",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "ui", label: "ui", description: "Open the interactive MCP control center" },
        { value: "status", label: "status", description: "Show server status" },
        { value: "tools", label: "tools", description: "List discovered tools" },
        { value: "reset", label: "reset", description: "Deactivate discovered tools" },
        { value: "reload", label: "reload", description: "Reload MCP configuration" },
      ];
      const matching = items.filter((item) => item.value.startsWith(prefix.trim()));
      return matching.length > 0 ? matching : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "ui", serverName] = trimmed.split(/\s+/);
      if ((subcommand === "ui" || trimmed === "") && ctx.mode === "tui") {
        const action = await showMcpDashboard(ctx, {
          getServers: () => [...(manager?.states.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
          getTools: () => [...records.values()].sort((a, b) => a.piName.localeCompare(b.piName)),
          isToolActive: (name) => pi.getActiveTools().includes(name),
          toggleTool: (name) => toggleMcpTool(name, ctx),
          schemaErrorCount: () => schemaErrors.size,
          configFiles: () => loadedConfig?.files ?? [],
        });
        if (action === "reload") {
          await ctx.reload();
          return;
        }
        if (action === "reset") resetMcpTools(ctx);
        return;
      }
      if (subcommand === "reload") {
        await ctx.reload();
        return;
      }
      if (subcommand === "reset") {
        resetMcpTools(ctx);
        return;
      }
      if (subcommand === "tools") {
        const selected = [...records.values()].filter((record) => !serverName || record.serverName === serverName);
        const preview = selected.slice(0, 30).map((record) => record.piName).join(", ");
        const suffix = selected.length > 30 ? ` … (+${selected.length - 30})` : "";
        ctx.ui.notify(selected.length > 0 ? `${preview}${suffix}` : "No matching MCP tools", "info");
        return;
      }
      if (subcommand !== "status" && subcommand !== "ui") {
        ctx.ui.notify("Usage: /mcp [ui|status|tools [server]|reset|reload]", "warning");
        return;
      }
      showStatus(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    const currentGeneration = generation;
    sessionContext = ctx;
    records.clear();
    identityToName.clear();
    usedNames.clear();
    registeredNames.clear();
    schemaErrors.clear();
    shownInstructions.clear();
    searchIndex.rebuild([]);

    loadedConfig = await loadMcpConfig({
      cwd: ctx.cwd,
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: ctx.isProjectTrusted(),
    });
    for (const warning of loadedConfig.warnings) ctx.ui.notify(warning, "warning");

    for (const key of LEGACY_STATUS_KEYS) ctx.ui.setStatus(key, undefined);
    if (loadedConfig.servers.size === 0) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== SEARCH_TOOL_NAME));
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const active = pi.getActiveTools();
    if (!active.includes(SEARCH_TOOL_NAME)) pi.setActiveTools([...active, SEARCH_TOOL_NAME]);
    ctx.ui.setStatus(STATUS_KEY, footerStatus(ctx, `MCP 0/${loadedConfig.servers.size}`));

    const createdManager = new McpManager(loadedConfig, ctx.cwd, async () => {
      if (generation !== currentGeneration || manager !== createdManager) return;
      rebuildCatalog(ctx);
      updateStatus(ctx);
    });
    manager = createdManager;
    createdManager.start();
  });

  pi.on("before_agent_start", async (event) => {
    const catalog = formatServerCatalog(loadedConfig);
    if (!catalog) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${catalog}` };
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreActiveTools(ctx);
  });

  pi.on("session_shutdown", async () => {
    generation += 1;
    sessionContext?.ui.setStatus(STATUS_KEY, undefined);
    for (const key of LEGACY_STATUS_KEYS) sessionContext?.ui.setStatus(key, undefined);
    const current = manager;
    manager = undefined;
    sessionContext = undefined;
    await current?.close();
  });

  function rebuildCatalog(ctx: ExtensionContext): void {
    const currentManager = manager;
    const config = loadedConfig;
    if (!currentManager || !config) return;
    const nextRecords = new Map<string, McpToolRecord>();
    const available = [...currentManager.states.values()]
      .filter((state) => state.status === "ready")
      .flatMap((state) => state.tools.map((tool) => ({ state, tool })))
      .sort((left, right) => `${left.state.name}\0${left.tool.name}`.localeCompare(`${right.state.name}\0${right.tool.name}`));

    for (const { state, tool } of available) {
      const identity = `${state.name}\0${tool.name}`;
      let piName = identityToName.get(identity);
      if (!piName) {
        piName = createMcpToolName(state.name, tool.name, usedNames);
        identityToName.set(identity, piName);
      }
      try {
        const parameters = normalizeMcpInputSchema(tool.inputSchema);
        const serverConfig = config.servers.get(state.name)?.config;
        const record: McpToolRecord = {
          id: identity,
          serverName: state.name,
          remoteName: tool.name,
          piName,
          label: tool.title ?? tool.annotations?.title ?? `${state.name}.${tool.name}`,
          description: withOutputPolicy(
            tool.description ?? `Call ${tool.name} on ${state.name}`,
            config.options.maxOutputLines,
            config.options.maxOutputBytes,
          ),
          serverDescription: serverConfig?.description,
          tool,
          searchText: schemaSearchText(tool.inputSchema),
          alwaysActive: serverConfig?.alwaysActiveTools?.includes(tool.name) ?? false,
        };
        nextRecords.set(identity, record);
        schemaErrors.delete(identity);
        if (!registeredNames.has(piName)) {
          registerRemoteTool(record, parameters, serverConfig?.supportsParallelToolCalls === true);
          registeredNames.add(piName);
        }
      } catch (error) {
        schemaErrors.set(identity, error instanceof Error ? error.message : String(error));
      }
    }

    records.clear();
    for (const [id, record] of nextRecords) records.set(id, record);
    searchIndex.rebuild(records.values());
    restoreActiveTools(ctx);
  }

  function registerRemoteTool(record: McpToolRecord, parameters: ReturnType<typeof normalizeMcpInputSchema>, parallel: boolean): void {
    const activeBefore = pi.getActiveTools();
    pi.registerTool<typeof parameters, McpToolDetails, McpRenderState>({
      name: record.piName,
      label: record.label,
      description: record.description,
      parameters,
      executionMode: parallel ? "parallel" : "sequential",
      async execute(toolCallId, params, signal, onUpdate) {
        const currentManager = manager;
        const config = loadedConfig;
        if (!currentManager || !config) throw new Error("MCP runtime is not available");
        const result = await currentManager.callTool(
          record.serverName,
          record.remoteName,
          params as Record<string, unknown>,
          {
            ...(signal ? { signal } : {}),
            onProgress(progress, total, message) {
              const suffix = total !== undefined ? `${progress}/${total}` : String(progress);
              onUpdate?.({
                content: [{ type: "text", text: message ? `${message} (${suffix})` : `MCP progress: ${suffix}` }],
                details: {
                  kind: "mcp-tool",
                  serverName: record.serverName,
                  remoteToolName: record.remoteName,
                  piToolName: record.piName,
                },
              });
            },
          },
        );
        const normalized = await normalizeMcpToolResult(
          result,
          record,
          toolCallId,
          {
            maxBytes: config.options.maxOutputBytes,
            maxLines: config.options.maxOutputLines,
          },
        );
        if (normalized.isError) throw new Error(normalized.errorText);
        return { content: normalized.content, details: normalized.details };
      },
      renderCall(args, theme, context) {
        const state = context.state;
        if (context.executionStarted && state.startedAt === undefined) {
          state.startedAt = Date.now();
          state.endedAt = undefined;
        }
        const serialized = compactJson(args, 180);
        const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        component.setText(
          `${theme.fg("toolTitle", theme.bold(`${record.serverName}.${record.remoteName}`))}${serialized ? ` ${theme.fg("muted", serialized)}` : ""}`,
        );
        return component;
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        const state = context.state;
        if (state.startedAt !== undefined && isPartial && !state.interval) {
          state.interval = setInterval(() => context.invalidate(), 1000);
        }
        if (!isPartial || context.isError) {
          state.endedAt ??= Date.now();
          if (state.interval) {
            clearInterval(state.interval);
            state.interval = undefined;
          }
        }

        const details = result.details;
        let raw = result.content.find((item) => item.type === "text")?.text ?? "";
        if (!isPartial && details?.fullOutputPath) raw = stripTruncationFooter(raw, details.fullOutputPath);
        const lines = raw ? raw.split("\n") : [];
        const shown = expanded ? raw : tailLines(raw, RESULT_PREVIEW_LINES);
        const color = context.isError ? "error" : "toolOutput";
        let text = shown ? `\n${theme.fg(color, shown)}` : "";
        if (!expanded && lines.length > RESULT_PREVIEW_LINES) {
          const skipped = lines.length - RESULT_PREVIEW_LINES;
          text = `\n${theme.fg("muted", `... (${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}${text}`;
        }
        if (details?.truncated || details?.fullOutputPath) {
          const warnings: string[] = [];
          if (details.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
          if (details.truncated) {
            const truncation = details.truncation;
            warnings.push(truncation?.truncatedBy === "lines"
              ? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
              : `Truncated: last ${formatSize(truncation?.outputBytes ?? loadedConfig?.options.maxOutputBytes ?? 0)} shown`);
          }
          text += `\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`;
        }
        if (state.startedAt !== undefined) {
          const end = state.endedAt ?? Date.now();
          text += `\n${theme.fg("muted", `${isPartial ? "Elapsed" : "Took"} ${((end - state.startedAt) / 1000).toFixed(1)}s`)}`;
        }
        const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        component.setText(text);
        return component;
      },
    });
    // Dynamic registration makes a tool active immediately. Restore the exact
    // previous set so MCP schemas stay deferred until mcp_search selects them.
    pi.setActiveTools(activeBefore);
  }

  function restoreActiveTools(ctx: ExtensionContext): void {
    const desired = new Set([...records.values()].filter((record) => record.alwaysActive).map((record) => record.piName));
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === SEARCH_TOOL_NAME) {
        const details = entry.message.details as Partial<McpSearchDetails> | undefined;
        if (details?.kind === "mcp-search") {
          for (const name of details.matches ?? []) desired.add(name);
        }
      } else if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as McpStateEntry | undefined;
        if (data?.action === "reset") {
          desired.clear();
          for (const record of records.values()) if (record.alwaysActive) desired.add(record.piName);
        } else if (data?.action === "set") {
          desired.clear();
          for (const name of data.activeToolNames) desired.add(name);
          for (const record of records.values()) if (record.alwaysActive) desired.add(record.piName);
        }
      }
    }
    const currentWithoutOwned = pi.getActiveTools().filter((name) => !registeredNames.has(name));
    const available = [...desired].filter((name) => registeredNames.has(name));
    pi.setActiveTools([...new Set([...currentWithoutOwned, SEARCH_TOOL_NAME, ...available])]);
  }

  function toggleMcpTool(name: string, ctx: ExtensionContext): void {
    const record = [...records.values()].find((candidate) => candidate.piName === name);
    if (!record || record.alwaysActive) return;
    const active = new Set(pi.getActiveTools());
    if (active.has(name)) active.delete(name);
    else active.add(name);
    pi.setActiveTools([...active]);
    const activeToolNames = [...records.values()]
      .filter((candidate) => active.has(candidate.piName))
      .map((candidate) => candidate.piName);
    pi.appendEntry<McpStateEntry>(STATE_ENTRY_TYPE, { action: "set", activeToolNames });
  }

  function resetMcpTools(ctx: ExtensionContext): void {
    const keep = pi.getActiveTools().filter((name) => !registeredNames.has(name));
    const always = [...records.values()].filter((record) => record.alwaysActive).map((record) => record.piName);
    pi.setActiveTools([...new Set([...keep, SEARCH_TOOL_NAME, ...always])]);
    pi.appendEntry<McpStateEntry>(STATE_ENTRY_TYPE, { action: "reset" });
    for (const key of LEGACY_STATUS_KEYS) ctx.ui.setStatus(key, undefined);
    ctx.ui.notify("Deactivated discovered MCP tools", "info");
  }

  function updateStatus(ctx: ExtensionContext): void {
    const currentManager = manager;
    const config = loadedConfig;
    if (!currentManager || !config) return;
    ctx.ui.setStatus(STATUS_KEY, footerStatus(ctx, `MCP ${currentManager.readyCount}/${config.servers.size}`));
  }

  function showStatus(ctx: ExtensionContext): void {
    const currentManager = manager;
    if (!currentManager || currentManager.states.size === 0) {
      ctx.ui.notify("No MCP servers configured", "info");
      return;
    }
    const lines = [...currentManager.states.values()].map((state) => {
      const detail = state.error ? ` — ${state.error}` : ` — ${state.tools.length} tools`;
      return `${state.name}: ${state.status}${detail}`;
    });
    if (schemaErrors.size > 0) lines.push(`${schemaErrors.size} tool schemas skipped`);
    ctx.ui.notify(lines.join("\n"), schemaErrors.size > 0 ? "warning" : "info");
  }

  function appendRelevantInstructions(lines: string[], matches: McpToolRecord[], config: LoadedMcpConfig): void {
    const currentManager = manager;
    if (!currentManager) return;
    for (const serverName of new Set(matches.map((record) => record.serverName))) {
      if (shownInstructions.has(serverName)) continue;
      const serverConfig = config.servers.get(serverName)?.config;
      const include = serverConfig?.includeInstructions ?? config.options.includeServerInstructions;
      const instructions = currentManager.states.get(serverName)?.instructions?.trim();
      if (!include || !instructions) continue;
      shownInstructions.add(serverName);
      lines.push(`Instructions from ${serverName}:\n${instructions.slice(0, 2000)}`);
    }
  }
}

function formatServerCatalog(config: LoadedMcpConfig | undefined): string | undefined {
  if (!config || config.servers.size === 0) return undefined;
  const lines = [...config.servers.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((server) => {
      const description = server.config.description?.trim().replace(/\s+/g, " ")
        || "No description configured.";
      return `- \`${server.name}\`: ${description}`;
    });
  return [
    "## Configured MCP servers",
    "",
    "MCP tool schemas are deferred. Use `mcp_search` when one of these server capabilities is relevant:",
    "",
    ...lines,
  ].join("\n");
}

function footerStatus(ctx: ExtensionContext, text: string): string {
  return ctx.mode === "tui" ? ctx.ui.theme.fg("dim", text) : text;
}

function searchResult(query: string, matches: string[], added: string[], text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { kind: "mcp-search" as const, query, matches, added },
  };
}

function withOutputPolicy(description: string, maxLines: number, maxBytes: number): string {
  const size = maxBytes % 1024 === 0 ? `${maxBytes / 1024}KB` : formatSize(maxBytes);
  return `${description} Output is truncated to the last ${maxLines} lines or ${size}; full output is saved to a temporary file when truncated.`;
}

function tailLines(value: string, count: number): string {
  const lines = value.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function stripTruncationFooter(value: string, fullOutputPath: string): string {
  if (!value.endsWith("]")) return value;
  const footerStart = value.lastIndexOf("\n\n[");
  if (footerStart === -1 || !value.slice(footerStart).includes(fullOutputPath)) return value;
  return value.slice(0, footerStart).trimEnd();
}

function compactJson(value: unknown, limit: number): string {
  try {
    const text = JSON.stringify(value);
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  } catch {
    return "";
  }
}
