# pi-mcp

Token-efficient MCP tool support for [pi](https://pi.dev). `pi-mcp` keeps configured servers disconnected and their tool schemas out of the initial prompt. The model activates one server with `mcp_active`, then loads only relevant tools from that server with `mcp_search`.

## Features

- MCP tools over stdio and Streamable HTTP
- Lazy, isolated per-server activation
- Paginated `tools/list` and `notifications/tools/list_changed`
- Per-server tool allowlists and denylists
- Model-visible server names with concise configured descriptions
- BM25-style deferred tool discovery
- Pi native deferred loading on supported Anthropic and OpenAI models
- Provider-safe tool names with collision handling
- Text, image, resource, structured-content, error, progress, timeout, and cancellation handling
- Bash-style output limiting with complete truncated results saved to temporary files
- Session branch restoration and clean process teardown
- Trusted project configuration

## Install

From this checkout:

```bash
pi install /absolute/path/to/pi-mcp
```

For development:

```bash
npm install
pi --no-extensions -e ./src/index.ts
```

## Configure

Create either:

- `~/.pi/agent/mcp.json` for user-wide servers
- `.pi/mcp.json` for project servers

Project configuration is loaded only after Pi trusts the project. A project server replaces a user server with the same name. Setting `enabled: false` in project configuration removes an inherited user server.

```json
{
  "mcpServers": {
    "filesystem": {
      "description": "Read files and browse directories in the current project",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "."
      ],
      "enabledTools": ["read_file", "list_directory"],
      "toolTimeoutMs": 60000
    },
    "github": {
      "description": "Search GitHub repositories, issues, and pull requests",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      },
      "disabledTools": ["delete_repository"]
    }
  },
  "options": {
    "searchLimit": 3,
    "maxOutputBytes": 51200,
    "maxOutputLines": 2000,
    "includeServerInstructions": true
  }
}
```

`${NAME}` references in commands, arguments, environment values, URLs, and headers are replaced from the Pi process environment. Missing variables fail only the affected server.

### Server options

| Option | Default | Meaning |
|---|---:|---|
| `description` | none | Capability summary shown concisely at startup, returned by `mcp_active`, and used for discovery |
| `enabled` | `true` | Make the server available for activation |
| `startupTimeoutMs` | `15000` | Initialize and inventory timeout |
| `toolTimeoutMs` | `60000` | Tool-call timeout |
| `enabledTools` | all | Raw MCP tool allowlist |
| `disabledTools` | none | Raw MCP tool denylist, applied after the allowlist |
| `alwaysActiveTools` | none | Raw tools exposed immediately after their server is activated |
| `includeInstructions` | global setting | Return bounded server instructions when one of its tools is first loaded |
| `supportsParallelToolCalls` | `false` | Permit this server's tool calls to execute concurrently |

The JSON Schema is available at [`schema/pi-mcp.schema.json`](schema/pi-mcp.schema.json).

## Model usage

In a fresh session, the model sees only `mcp_active` and a compact catalog containing server names and concise configured descriptions. Descriptions are collapsed to one line and capped at 160 characters in the startup prompt:

```text
## Configured MCP servers

MCP servers and their tool schemas are inactive by default:

- `filesystem`: Read files and browse directories in the current project
- `github`: Search GitHub repositories, issues, and pull requests
```

The model activates only the server needed for the task:

```text
mcp_active(server="github")
```

After the connection and tool inventory complete, the result returns that server's full configured description and tool count. It also makes `mcp_search` available. Searches must name one active server:

```text
mcp_search(server="github", query="find pull requests", limit=3)
```

The server parameter prevents unrelated servers from competing for search results. Server descriptions participate in discovery after activation, so capability terms from the description can lead to relevant tools.

A search activates a small number of exact MCP tools from only that server. On models with native deferred-tool support, Pi inserts tool references without rebuilding the stable prompt prefix. Other models receive the newly active schemas normally on their next request. The catalog and activation result never include commands, URLs, environment values, or HTTP headers.

Server-provided MCP instructions are included once, with the first successful tool search for that server, by default. Set global `includeServerInstructions` or per-server `includeInstructions` to `false` to disable them.

MCP tools deliberately omit Pi prompt snippets and guidelines, so activation does not change the system prompt. Their descriptions expose only the tool capability and output contract, not bridge implementation details.

### Output limits

Text output follows Pi's built-in `bash` convention: the last 2000 lines or 50 KiB are returned by default, whichever limit is reached first. A truncated result includes a temporary-file path containing the complete text output. The limits can be changed with `maxOutputLines` and `maxOutputBytes`.

## Commands and control center

Run `/mcp` with no arguments to open the interactive tabbed control center:

- **Overview** — active server count, active tool count, schema errors, and config files
- **Servers** — per-server state, tool count, source, errors, and stderr
- **Tools** — browse and enable/disable individual MCP tools

Keyboard controls: Tab or ←/→ switches tabs, ↑/↓ navigates, Enter/Space toggles a tool, `r` reloads, `x` resets discovered tools, and Escape closes the panel.

The `/mcp` command also provides Tab-completed subcommands:

```text
/mcp ui              Open the interactive control center
/mcp status          Show connection status and tool counts
/mcp tools [server]  Show discovered tool names
/mcp reset           Deactivate tools loaded through discovery
/mcp reload          Reload the extension and configuration
```

Pi's built-in `/reload` works as well.

## Security

MCP servers and their tools execute with the permissions of the Pi process.

- Review server commands before adding them.
- Prefer `enabledTools` for servers with broad or destructive capabilities.
- Project MCP configuration requires Pi project trust.
- This extension does not execute shell commands to obtain secrets.
- Resolved environment values and HTTP headers are not written to sessions or logs.
- Existing Pi `tool_call` permission extensions can block `mcp_*` tools.

## Current scope

This release implements the MCP **tools** capability. Resources, prompts, OAuth, elicitation, roots, legacy SSE, and experimental task-required tools are planned separately so they do not complicate or increase the prompt cost of the tool bridge.

## Development

```bash
npm run check
npm test
```
