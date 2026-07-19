import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpToolSearchIndex } from "../src/search.js";
import type { McpToolRecord } from "../src/types.js";

function record(
  serverName: string,
  remoteName: string,
  description: string,
  serverDescription?: string,
): McpToolRecord {
  const tool: Tool = { name: remoteName, description, inputSchema: { type: "object", properties: {} } };
  return {
    id: `${serverName}\0${remoteName}`,
    serverName,
    remoteName,
    piName: `mcp_${serverName}_${remoteName}`,
    label: remoteName,
    description,
    serverDescription,
    tool,
    searchText: description,
    alwaysActive: false,
  };
}

test("search prefers names and relevant descriptions", () => {
  const index = new McpToolSearchIndex();
  index.rebuild([
    record("github", "search_issues", "Search repository issues and pull requests"),
    record("calendar", "create_event", "Create a calendar meeting"),
    record("weather", "forecast", "Get rain and temperature predictions"),
  ]);
  assert.equal(index.search("github issues", 2)[0]?.remoteName, "search_issues");
  assert.equal(index.search("schedule meeting", 2)[0]?.remoteName, "create_event");
});

test("search indexes configured server descriptions", () => {
  const index = new McpToolSearchIndex();
  index.rebuild([
    record("ida", "decompile", "Render pseudocode for a function", "Reverse engineering and binary analysis"),
    record("calendar", "create_event", "Create a calendar meeting", "Calendar scheduling"),
  ]);
  assert.equal(index.search("binary analysis", 1)[0]?.remoteName, "decompile");
});

test("search can be restricted to one MCP server", () => {
  const index = new McpToolSearchIndex();
  index.rebuild([
    record("alpha", "search_alpha", "Search shared records"),
    record("beta", "search_beta", "Search shared records"),
  ]);
  assert.equal(index.search("shared records", 5, "beta")[0]?.remoteName, "search_beta");
  assert.equal(index.search("shared records", 5, "missing").length, 0);
});
