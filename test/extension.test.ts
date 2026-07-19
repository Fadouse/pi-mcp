import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piMcpExtension from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/test-mcp-server.ts", import.meta.url));

test("extension lazily activates a server, searches only that server, and executes a tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-extension-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      test: {
        description: "Echo messages through a test service",
        command: process.execPath,
        args: ["--import", "tsx", fixture],
        cwd: process.cwd(),
        startupTimeoutMs: 10_000,
      },
    },
  }));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => Promise<any> | any>>();
  let active: string[] = [];
  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    registerCommand() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...names]; },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    cwd: root,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify() {},
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
    },
  } as unknown as ExtensionContext;

  piMcpExtension(pi);
  try {
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    const promptHandler = handlers.get("before_agent_start")?.[0];
    assert.ok(promptHandler);
    const promptResult = await promptHandler({ systemPrompt: "base prompt" }, ctx) as { systemPrompt: string };
    assert.match(promptResult.systemPrompt, /## Configured MCP servers/);
    assert.match(promptResult.systemPrompt, /- `test`/);
    assert.doesNotMatch(promptResult.systemPrompt, /Echo messages through a test service/);
    assert.doesNotMatch(promptResult.systemPrompt, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(active, ["mcp_active"]);
    assert.equal(statuses.get("20-pi-mcp"), "MCP 0/1 active");

    const search = tools.get("mcp_search");
    assert.ok(search);
    const inactiveSearch = await search.execute(
      "inactive-search",
      { server: "test", query: "echo message" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(inactiveSearch.content[0]?.type === "text" ? inactiveSearch.content[0].text : "", /not active/);

    const activate = tools.get("mcp_active");
    assert.ok(activate);
    const activateResult = await activate.execute(
      "active-call",
      { server: "test" },
      undefined,
      undefined,
      ctx,
    );
    const activateText = activateResult.content[0]?.type === "text" ? activateResult.content[0].text : "";
    assert.match(activateText, /Description: Echo messages through a test service/);
    assert.match(activateText, /Discovered tools: 1/);
    assert.ok(active.includes("mcp_search"));

    const searchResult = await search.execute(
      "search-call",
      { server: "test", query: "echo message" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "", /Loaded MCP tools from test/);
    const remoteName = active.find((name) => name.startsWith("mcp_test_echo_message"));
    assert.ok(remoteName);
    const remote = tools.get(remoteName);
    assert.ok(remote);
    assert.match(remote.description, /Output is truncated to the last 2000 lines or 50KB/);
    assert.doesNotMatch(remote.description, /MCP server/i);
    const result = await remote.execute("remote-call", { message: "works" }, undefined, undefined, ctx);
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "echo:works");
    assert.equal(statuses.get("20-pi-mcp"), "MCP 1/1 active");
    assert.equal(statuses.get("pi-mcp"), undefined);
    assert.equal(statuses.get("pi-mcp-tools"), undefined);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
