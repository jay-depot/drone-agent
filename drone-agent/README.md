# DRONE-AGENT

This is the TUI for the `drone` coding agent. It is yet another "minimalist" coding agent running in yolo mode built on TypeScript.

By default, drone-agent runs with a minimal built-in set so it can bootstrap a session, execute shell commands, and chat through Ollama.

Plugins allow you to extend the capabilities of `drone`. The current built-in plugins are:

- `startup`: boots the local runtime and provides a simple status tool.
- `exec`: provides `exec.run` for local shell execution.
- `todo`: provides `todo.manage_list` and injects the current todo list into system prompts. This plugin is built in but opt-in (not enabled by default).
- `fetch`: provides `fetch.request` for simple HTTP GET and POST requests. This plugin is built in but opt-in.
- `utils`: provides deterministic arithmetic and text-metric tools. This plugin is built in but opt-in.
- `lsp`: provides diagnostics, hover lookups, and server status through language servers. This plugin is built in but opt-in.
- `mcp`: connects to MCP servers and mounts their tools/resources/prompts under the `mcp.` tool namespace.
- `ollama`: provides the chat model capability.

## Installation

To install `drone-agent`, simply run:

```bash
npm install -g drone-agent
```

## Usage

To start `drone-agent`, simply run:

```bash
drone-agent
```

The first time you run `drone-agent`, it will ask you how to connect to an Ollama instance. Accept the default (local) if you have Ollama running locally, or enter the URL of your Ollama instance if it's running elsewhere.

After that, `drone-agent` will introduce itself and ask if you want it to help you set it up.

## Configuration

`drone-agent` has a multi-level configuration system.

Project level configuration is stored in a `.drone-agent` directory in the root of your project. This is where you can specify which plugins to enable for this project, install custom plugins for this project, and configure project specific skills or memory stores.

User level configuration is stored in the user's home directory under `.drone-agent`. This is where you can specify global plugins that should be enabled for all projects, as well as any user specific skills or memory stores.

### LSP Plugin

The `lsp` plugin is opt-in. It is intended to make `drone-agent` behave more like an IDE client by maintaining language-server connections, collecting diagnostics, and exposing semantic queries to the model.

Current phase-1 tools:

- `lsp.get_diagnostics`: returns current diagnostics for the workspace or a specific file.
- `lsp.hover`: returns hover information for a symbol at a file, line, and column.
- `lsp.go_to_definition`: resolves definition location(s) for a symbol at a file, line, and column.
- `lsp.find_references`: finds references for a symbol at a file, line, and column.
- `lsp.server_status`: shows whether a server was connected, spawned, skipped, or failed.

Current phase-1 support is TypeScript/JavaScript first. The plugin architecture is generic, but only TypeScript/JavaScript has a built-in auto-spawn path right now.

If drone-agent spawns a language server itself, that server exits when drone-agent exits. If drone-agent connects to an externally managed server, it leaves that server running.

#### Auto-installing language servers

By default, the plugin tries to use a language server from your `PATH` and otherwise downloads a pinned copy into a per-user cache. The cache lives at:

- Linux: `$XDG_CACHE_HOME/drone-agent/lsp/` (defaults to `~/.cache/drone-agent/lsp/`)
- macOS: `~/Library/Caches/drone-agent/lsp/`
- Windows: `%LOCALAPPDATA%\drone-agent\lsp\`

Override the cache root with `DRONE_AGENT_LSP_CACHE`. Delete that directory to reset.

Auto-install downloads the npm tarball for the server (currently `typescript-language-server@5.3.0`), verifies its sha512 integrity, extracts it, and invokes it via the running Node interpreter. The integrity digest is pinned in the plugin source, so the threat model matches a regular `npm install`.

Disable auto-install globally or per-server:

```json
{
  "lsp": {
    "autoInstall": false,
    "servers": {
      "typescript": {
        "autoInstall": true
      }
    }
  }
}
```

If auto-install is disabled and the server isn't on `PATH`, the runtime degrades to `status: "error"` with a clear `lastError`, identical to the pre–auto-install behavior. The `lsp.server_status` tool reports `installSource: "path" | "cache"` and `installStatus: "unused" | "cached" | "downloaded" | "failed"` so you can see what happened.

Example project config:

```json
{
  "enabledPlugins": ["lsp"],
  "lsp": {
    "enabled": true,
    "diagnosticTokenBudget": 500,
    "requestTimeoutMs": 5000,
    "preferExternal": false,
    "servers": {
      "typescript": {
        "transport": "stdio",
        "language": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "fileExtensions": [".ts", ".tsx", ".js", ".jsx"],
        "rootPatterns": ["tsconfig.json", "package.json"]
      }
    }
  }
}
```

You can also attach to an existing external server instead of spawning your own:

```json
{
  "enabledPlugins": ["lsp"],
  "lsp": {
    "enabled": true,
    "preferExternal": true,
    "servers": {
      "typescript-external": {
        "transport": "tcp",
        "language": "typescript",
        "host": "127.0.0.1",
        "port": 6010,
        "fileExtensions": [".ts", ".tsx", ".js", ".jsx"]
      }
    }
  }
}
```

For the built-in TypeScript path, you can either install `typescript-language-server` somewhere on your `PATH` (the plugin will use it directly) or rely on auto-install (the default).

### MCP Plugin

The `mcp` plugin mounts capabilities from configured MCP servers directly into the tool list.

Mounted tool naming:

- MCP tools: `mcp.<serverId>.<toolName>`
- MCP helpers: `mcp.<serverId>.list_resources`, `mcp.<serverId>.read_resource`, `mcp.<serverId>.list_prompts`, `mcp.<serverId>.get_prompt`
- Global status: `mcp.server_status`

MVP transport support:

- `stdio` (spawned by drone-agent)
- `streamable_http` (external endpoint)

If drone-agent spawns a stdio MCP server, it is shut down when drone-agent exits. External HTTP MCP servers are never lifecycle-managed by drone-agent.

Example stdio server config:

```json
{
  "mcp": {
    "enabled": true,
    "requestTimeoutMs": 10000,
    "servers": {
      "filesystem": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${PWD}"]
      }
    }
  }
}
```

Example streamable HTTP server config with env interpolation:

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "remote": {
        "transport": "streamable_http",
        "url": "${MCP_REMOTE_URL}",
        "headers": {
          "Authorization": "Bearer ${MCP_REMOTE_TOKEN}"
        }
      }
    }
  }
}
```

Any `${VAR_NAME}` references in MCP config are resolved from environment variables during config load.

Hardening options now supported:

- Pagination guards: `maxListPages`, `maxListItems`
- Streamable HTTP compatibility mode: `compatibilityMode` (`strict` or `permissive`)
- Retry policy knobs: `retryCount`, `retryDelayMs`
- Per-server tool allowlists: `allowedTools`

Retry behavior is conservative:

- idempotent operations (`tools/list`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`) can retry
- `tools/call` does not retry by default to avoid duplicate side effects

Example with allowlist and pagination controls:

```json
{
  "mcp": {
    "enabled": true,
    "requestTimeoutMs": 10000,
    "retryCount": 1,
    "retryDelayMs": 200,
    "maxListPages": 25,
    "maxListItems": 500,
    "compatibilityMode": "strict",
    "servers": {
      "filesystem": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${PWD}"],
        "allowedTools": ["read_file", "list_directory"],
        "maxListItems": 250
      },
      "remote": {
        "transport": "streamable_http",
        "url": "${MCP_REMOTE_URL}",
        "headers": {
          "Authorization": "Bearer ${MCP_REMOTE_TOKEN}"
        },
        "compatibilityMode": "permissive",
        "retryCount": 2,
        "retryDelayMs": 300
      }
    }
  }
}
```

## Future Swarm Direction

The longer-term plan is to support a distributed "swarm" mode, while keeping the default local runtime minimal and replaceable.

Status: Planned (not implemented in the current release).

Planned pieces include:

- `drone-beacon`: host-local coordination for multiple drone instances, shared memory channels, and autonomous task scheduling.
- `drone-coordinator`: cross-host control plane for managing beacons across machines.
- swarm-level shared assets: shared skills, memories, and personas (without forcing shared plugin sets).

In that model, local and user config remain the base, with optional beacon/swarm overlays for collaboration use cases such as team-wide troubleshooting personas.
