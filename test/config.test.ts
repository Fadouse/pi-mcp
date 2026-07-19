import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandConfigValue, loadMcpConfig } from "../src/config.js";

test("project config overrides global config only when trusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      docs: { description: "Global documentation", command: "global-server" },
      global: { description: "Global services", command: "global-only" },
      disabled: { command: "disabled-global" },
    },
  }));
  await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: {
      docs: { description: "Project documentation", command: "project-server" },
      disabled: { enabled: false },
    },
    options: { searchLimit: 5 },
  }));

  const untrusted = await loadMcpConfig({ cwd: project, configDirName: ".pi", projectTrusted: false, agentDir });
  assert.equal(untrusted.servers.get("docs")?.config.command, "global-server");
  assert.equal(untrusted.servers.get("docs")?.config.description, "Global documentation");
  assert.equal(untrusted.options.includeServerInstructions, true);

  const trusted = await loadMcpConfig({ cwd: project, configDirName: ".pi", projectTrusted: true, agentDir });
  assert.equal(trusted.servers.get("docs")?.config.command, "project-server");
  assert.equal(trusted.servers.get("docs")?.config.description, "Project documentation");
  assert.equal(trusted.servers.get("global")?.config.command, "global-only");
  assert.equal(trusted.servers.has("disabled"), false);
  assert.equal(trusted.options.searchLimit, 5);
});

test("server descriptions must be non-empty strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-description-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      empty: { description: "   ", command: "empty-server" },
      numeric: { description: 42, command: "numeric-server" },
    },
  }));

  const loaded = await loadMcpConfig({ cwd: root, configDirName: ".pi", projectTrusted: false, agentDir });
  assert.equal(loaded.servers.size, 0);
  assert.match(loaded.warnings.join("\n"), /description must not be empty/);
  assert.match(loaded.warnings.join("\n"), /description must be a string/);
});

test("environment expansion rejects missing secrets", () => {
  assert.equal(expandConfigValue("Bearer ${TOKEN}", { TOKEN: "secret" }), "Bearer secret");
  assert.throws(() => expandConfigValue("${MISSING}", {}), /MISSING is not set/);
});
