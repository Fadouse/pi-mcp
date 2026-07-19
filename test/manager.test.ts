import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpManager } from "../src/manager.js";
import type { LoadedMcpConfig } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/test-mcp-server.ts", import.meta.url));

test("keeps servers idle until explicitly activated, then lists and calls tools", async () => {
  const config: LoadedMcpConfig = {
    servers: new Map([
      [
        "test",
        {
          name: "test",
          sourcePath: "<test>",
          config: {
            command: process.execPath,
            args: ["--import", "tsx", fixture],
            startupTimeoutMs: 10_000,
            toolTimeoutMs: 10_000,
          },
        },
      ],
    ]),
    options: {
      searchLimit: 3,
      maxOutputBytes: 50 * 1024,
      maxOutputLines: 2000,
      includeServerInstructions: false,
    },
    files: [],
    warnings: [],
  };
  let updates = 0;
  const manager = new McpManager(config, process.cwd(), () => { updates += 1; });
  try {
    assert.equal(manager.states.get("test")?.status, "idle");
    const state = await manager.activateServer("test");
    assert.equal(state.status, "ready", state.error);
    assert.equal(state?.tools[0]?.name, "echo_message");
    const result = await manager.callTool("test", "echo_message", { message: "hi" }, {}) as {
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "echo:hi");
    assert.ok(updates >= 1);
  } finally {
    await manager.close();
  }
});
