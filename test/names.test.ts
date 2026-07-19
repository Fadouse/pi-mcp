import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToolName, fitUtf8, sanitizePart } from "../src/names.js";

test("MCP names are provider-safe and bounded", () => {
  const used = new Map<string, string>();
  const name = createMcpToolName("GitHub Enterprise!", "issues/search-with-a-very-long-name".repeat(4), used);
  assert.match(name, /^[a-z0-9_]+$/);
  assert.ok(Buffer.byteLength(name) <= 64);
});

test("colliding normalized names receive stable hash suffixes", () => {
  const used = new Map<string, string>();
  const first = createMcpToolName("my-server", "read.file", used);
  const second = createMcpToolName("my.server", "read-file", used);
  assert.equal(first, "mcp_my_server_read_file");
  assert.notEqual(second, first);
  assert.match(second, /^mcp_my_server_read_file_[a-f0-9]{10}$/);
});

test("sanitization and UTF-8 fitting always return usable identifiers", () => {
  assert.equal(sanitizePart("Crème brûlée"), "creme_brulee");
  assert.equal(sanitizePart("你好"), "tool");
  assert.ok(Buffer.byteLength(fitUtf8("é".repeat(100), 11)) <= 11);
});
