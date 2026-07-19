import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeMcpToolResult } from "../src/result.js";

test("normalizes text, images, resources, and structured content", async () => {
  const result = await normalizeMcpToolResult(
    {
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link", uri: "docs://one", name: "Docs" },
      ],
      structuredContent: { count: 1 },
    },
    { serverName: "test", remoteName: "mixed", piName: "mcp_test_mixed" },
    "call-1",
    { maxBytes: 1024, maxLines: 100 },
  );
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[1]?.type, "image");
  assert.deepEqual(result.details.structuredContent, { count: 1 });
});

test("truncates text and saves the complete output", async () => {
  const full = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  const result = await normalizeMcpToolResult(
    { content: [{ type: "text", text: full }] },
    { serverName: "test", remoteName: "large", piName: "mcp_test_large" },
    "call-2",
    { maxBytes: 1000, maxLines: 3 },
  );
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.truncation?.outputLines, 3);
  assert.ok(result.details.fullOutputPath);
  assert.match(result.details.fullOutputPath, /\/tmp\/pi-mcp-/);
  const visible = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(visible, /line-17\nline-18\nline-19/);
  assert.doesNotMatch(visible, /(?:^|\n)line-0(?:\n|$)/);
  assert.match(visible, /Showing lines 18-20 of 20/);
  assert.equal(await readFile(result.details.fullOutputPath, "utf8"), full);
});

test("preserves MCP error status", async () => {
  const result = await normalizeMcpToolResult(
    { isError: true, content: [{ type: "text", text: "remote failure" }] },
    { serverName: "test", remoteName: "fail", piName: "mcp_test_fail" },
    "call-3",
    { maxBytes: 1000, maxLines: 100 },
  );
  assert.equal(result.isError, true);
  assert.equal(result.errorText, "remote failure");
});
