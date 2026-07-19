import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "pi-mcp-test", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.registerTool(
  "echo_message",
  {
    description: "Echo a message for integration testing",
    inputSchema: z.object({ message: z.string().describe("Message to echo") }),
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }),
);

await server.connect(new StdioServerTransport());
