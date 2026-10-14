# mcp-swarm

A reference **swarm extension**: it connects to a drone coordinator as an
extension node and exposes a small catalog of swarm functions to any **MCP
client** (Claude Code, etc.) over stdio.

It is also the end-to-end acceptance fixture for the swarm-extension protocol:
one process that declares a capability manifest, receives session lifecycle
events, injects prompt fragments / reminders / tools into agent sessions, and
serves a front-end bundle to the coordinator UI.

## What it does

1. **Registers** with the coordinator via `POST /api/beacons` (mTLS), using an
   Ed25519 identity + TLS cert generated under the data dir. On a local host
   the coordinator auto-approves it.
2. **Declares a capability catalog** over the `/ws/beacon` WebSocket:
   - `swarm.session.list` — list agent sessions (`GET /api/sessions`)
   - `swarm.wiki.read` — read a wiki page (`GET /api/wiki/:pageId`)
   - `swarm.agent.list` — list agent locations (`GET /api/agents/location`)
3. **Serves MCP tools** over stdio — the catalog is exposed 1:1 as MCP tools.
   Each tool call maps straight onto the capability's coordinator REST request.
4. **Uploads a front-end bundle** (`status-panel`) so the coordinator UI's
   Extensions surface has something real to render.

## Usage

```bash
# Start the coordinator + a beacon, then:
pnpm --filter mcp-swarm run build
node mcp-swarm/bin/mcp-swarm
```

Register it with an MCP client (e.g. Claude Code):

```jsonc
{
  "mcpServers": {
    "swarm": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-swarm/bin/mcp-swarm"],
      "env": {
        "MCP_SWARM_COORDINATOR_URL": "http://127.0.0.1:3456",
      },
    },
  },
}
```

### Environment

| Variable                    | Default                    | Purpose                        |
| --------------------------- | -------------------------- | ------------------------------ |
| `MCP_SWARM_COORDINATOR_URL` | `http://127.0.0.1:3456`    | Coordinator to connect to.     |
| `MCP_SWARM_DATA_DIR`        | `~/.drone-agent/mcp-swarm` | Identity + TLS storage.        |
| `MCP_SWARM_ID`              | `mcp-swarm`                | Node id used for registration. |

## Capability catalog as the single source of truth

`src/mapping.ts` declares each capability once (name, description, param
schema) and maps it to a coordinator REST request. The same catalog drives:

- the **MCP tools** this process serves (`src/mcp-server.ts`), and
- the **coordinator-proxied actions/tools** the coordinator routes to this node
  (the `invokeAction` / `invokeTool` WS commands, handled in `src/index.ts`).

## Layout

| File                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `src/mapping.ts`    | Capability catalog + coordinator REST mapping + executor.                  |
| `src/mcp-server.ts` | Dependency-free MCP stdio server (`initialize`/`tools/list`/`tools/call`). |
| `src/bundle.ts`     | The embedded `status-panel` front-end bundle.                              |
| `src/index.ts`      | Wires the extension node to the MCP server.                                |
| `bin/mcp-swarm`     | Executable shim.                                                           |

## Notes

- Extensions are **local-only** in v0 (same host as the coordinator).
- The MCP server is dependency-free: it speaks the MCP stdio framing
  (`Content-Length: N\r\n\r\n{...}`) directly, so it can be pointed at any MCP
  client without bundling the SDK.
