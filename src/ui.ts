import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { McpToolRecord, ServerState } from "./types.js";

export type McpDashboardAction = "close" | "reload" | "reset";

export interface McpDashboardModel {
  getServers(): ServerState[];
  getTools(): McpToolRecord[];
  isToolActive(name: string): boolean;
  toggleTool(name: string): void;
  schemaErrorCount(): number;
  configFiles(): string[];
}

export async function showMcpDashboard(
  ctx: ExtensionContext,
  model: McpDashboardModel,
): Promise<McpDashboardAction> {
  if (ctx.mode !== "tui") return "close";

  return ctx.ui.custom<McpDashboardAction>((tui, theme, _keybindings, done) => {
    const tabs = ["Overview", "Servers", "Tools"] as const;
    let tabIndex = 0;
    let serverIndex = 0;
    let toolIndex = 0;

    const refresh = () => tui.requestRender();
    const moveTab = (delta: number) => {
      tabIndex = (tabIndex + delta + tabs.length) % tabs.length;
      refresh();
    };

    const handleInput = (data: string) => {
      if (matchesKey(data, Key.escape)) return done("close");
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return moveTab(1);
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return moveTab(-1);
      if (data === "r") return done("reload");
      if (data === "x") return done("reset");

      if (tabIndex === 1) {
        const servers = model.getServers();
        if (matchesKey(data, Key.up) || data === "k") serverIndex = Math.max(0, serverIndex - 1);
        if (matchesKey(data, Key.down) || data === "j") serverIndex = Math.min(Math.max(0, servers.length - 1), serverIndex + 1);
        refresh();
        return;
      }

      if (tabIndex === 2) {
        const tools = model.getTools();
        if (matchesKey(data, Key.up) || data === "k") toolIndex = Math.max(0, toolIndex - 1);
        if (matchesKey(data, Key.down) || data === "j") toolIndex = Math.min(Math.max(0, tools.length - 1), toolIndex + 1);
        const selected = tools[toolIndex];
        if ((matchesKey(data, Key.space) || matchesKey(data, Key.enter)) && selected) {
          model.toggleTool(selected.piName);
        }
        refresh();
      }
    };

    const render = (width: number): string[] => {
      const safeWidth = Math.max(1, width);
      const lines: string[] = [];
      const add = (line = "") => lines.push(truncateToWidth(line, safeWidth, ""));
      add(theme.fg("accent", "─".repeat(safeWidth)));
      add(` ${theme.fg("accent", theme.bold("MCP Control Center"))}`);
      add(renderTabs());
      add("");

      if (tabIndex === 0) renderOverview(add);
      else if (tabIndex === 1) renderServers(add);
      else renderTools(add);

      add("");
      add(` ${theme.fg("dim", "tab/←→ switch • ↑↓ navigate • enter/space toggle • r reload • x reset • esc close")}`);
      add(theme.fg("accent", "─".repeat(safeWidth)));
      return lines;
    };

    const renderTabs = (): string => {
      const rendered = tabs.map((tab, index) => {
        const label = ` ${tab} `;
        return index === tabIndex
          ? theme.bg("selectedBg", theme.fg("text", label))
          : theme.fg("muted", label);
      });
      return ` ${rendered.join(" ")}`;
    };

    const renderOverview = (add: (line?: string) => void): void => {
      const servers = model.getServers();
      const tools = model.getTools();
      const ready = servers.filter((server) => server.status === "ready").length;
      const failed = servers.filter((server) => server.status === "failed").length;
      const active = tools.filter((tool) => model.isToolActive(tool.piName)).length;
      add(` ${theme.fg("text", "Servers")}  ${theme.fg(ready === servers.length ? "success" : "warning", `${ready}/${servers.length} ready`)}`);
      add(` ${theme.fg("text", "Tools")}    ${theme.fg("accent", `${active}/${tools.length} active`)}`);
      if (failed > 0) add(` ${theme.fg("error", `${failed} server${failed === 1 ? "" : "s"} failed`)}`);
      const schemaErrors = model.schemaErrorCount();
      if (schemaErrors > 0) add(` ${theme.fg("warning", `${schemaErrors} unsupported tool schema${schemaErrors === 1 ? "" : "s"}`)}`);
      add("");
      add(` ${theme.fg("muted", "Configuration")}`);
      const files = model.configFiles();
      if (files.length === 0) add(` ${theme.fg("dim", "No mcp.json files found")}`);
      for (const file of files) add(` ${theme.fg("dim", file)}`);
      add("");
      add(` ${theme.fg("dim", "Servers stay idle until mcp_active starts them; their tools stay hidden until mcp_search loads matches.")}`);
    };

    const renderServers = (add: (line?: string) => void): void => {
      const servers = model.getServers();
      serverIndex = Math.min(serverIndex, Math.max(0, servers.length - 1));
      if (servers.length === 0) {
        add(` ${theme.fg("dim", "No MCP servers configured")}`);
        return;
      }
      const start = viewportStart(serverIndex, servers.length, 10);
      for (let index = start; index < Math.min(servers.length, start + 10); index += 1) {
        const server = servers[index];
        if (!server) continue;
        const selected = index === serverIndex;
        const icon = server.status === "ready" ? "●" : server.status === "failed" ? "×" : server.status === "connecting" ? "◌" : "○";
        const color = server.status === "ready" ? "success" : server.status === "failed" ? "error" : "warning";
        const row = `${selected ? ">" : " "} ${theme.fg(color, icon)} ${server.name}  ${theme.fg("dim", `${server.status} • ${server.tools.length} tools`)}`;
        add(selected ? theme.bg("selectedBg", row) : row);
      }
      const selected = servers[serverIndex];
      if (selected) {
        add("");
        add(` ${theme.fg("muted", "Source:")} ${selected.sourcePath}`);
        if (selected.serverInfo) add(` ${theme.fg("muted", "Server:")} ${selected.serverInfo.name} ${selected.serverInfo.version}`);
        if (selected.error) add(` ${theme.fg("error", selected.error)}`);
        if (selected.stderr) add(` ${theme.fg("dim", `stderr: ${selected.stderr.trim().split("\n").at(-1) ?? ""}`)}`);
      }
    };

    const renderTools = (add: (line?: string) => void): void => {
      const tools = model.getTools();
      toolIndex = Math.min(toolIndex, Math.max(0, tools.length - 1));
      if (tools.length === 0) {
        add(` ${theme.fg("dim", "No MCP tools discovered yet")}`);
        return;
      }
      const start = viewportStart(toolIndex, tools.length, 12);
      for (let index = start; index < Math.min(tools.length, start + 12); index += 1) {
        const tool = tools[index];
        if (!tool) continue;
        const selected = index === toolIndex;
        const enabled = model.isToolActive(tool.piName);
        const check = enabled ? theme.fg("success", "■") : theme.fg("dim", "□");
        const row = `${selected ? ">" : " "} ${check} ${tool.piName} ${theme.fg("dim", `(${tool.serverName})`)}`;
        add(selected ? theme.bg("selectedBg", row) : row);
      }
      const selected = tools[toolIndex];
      if (selected) {
        add("");
        add(` ${theme.fg("muted", selected.description)}`);
      }
    };

    return {
      render,
      invalidate() {},
      handleInput,
    };
  });
}

function viewportStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, selected - Math.floor(size / 2)), total - size);
}
