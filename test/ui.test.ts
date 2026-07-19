import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpToolRecord, ServerState } from "../src/types.js";
import { showMcpDashboard } from "../src/ui.js";

const server: ServerState = {
  name: "github",
  sourcePath: "/tmp/mcp.json",
  status: "ready",
  tools: [],
  serverInfo: { name: "github-mcp", version: "1.0.0" },
};
const tool: McpToolRecord = {
  id: "github\0search_issues",
  serverName: "github",
  remoteName: "search_issues",
  piName: "mcp_github_search_issues",
  label: "Search Issues",
  description: "Search repository issues",
  tool: { name: "search_issues", inputSchema: { type: "object", properties: {} } },
  searchText: "issues",
  alwaysActive: false,
};

test("MCP dashboard has tabs and toggles tools", async () => {
  let active = false;
  let toolsTab = "";
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Function) => new Promise<string>((resolve) => {
        const component = factory(
          { requestRender() {} },
          theme,
          {},
          resolve,
        );
        const overview = component.render(100).join("\n");
        assert.match(overview, /Overview/);
        assert.match(overview, /Servers/);
        assert.match(overview, /Tools/);
        component.handleInput("\t");
        component.handleInput("\t");
        toolsTab = component.render(100).join("\n");
        component.handleInput(" ");
        component.handleInput("\x1b");
      }),
    },
  } as unknown as ExtensionContext;

  const action = await showMcpDashboard(ctx, {
    getServers: () => [server],
    getTools: () => [tool],
    isToolActive: () => active,
    toggleTool: () => { active = !active; },
    schemaErrorCount: () => 0,
    configFiles: () => ["/tmp/mcp.json"],
  });
  assert.match(toolsTab, /mcp_github_search_issues/);
  assert.equal(active, true);
  assert.equal(action, "close");
});
