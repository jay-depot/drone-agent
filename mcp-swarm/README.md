# mcp-swarm

A reference **swarm extension**: it connects to a drone coordinator as an
extension node and exposes a small catalog of swarm functions to any **MCP
client** (Claude Code, etc.) over **streamable HTTP**.

It runs as a long-lived daemon. That lets one process — not many — hold settings
(the **auth token store**) and serve a **settings panel** to the coordinator UI.

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
   - `token.*` — UI-only token management (see below)
3. **Serves MCP over streamable HTTP** on `POST /mcp` — the `mcp`-tier catalog
   is exposed 1:1 as MCP tools. Each tool call maps onto the capability's
   coordinator REST request.
4. **Uploads a front-end bundle** so the coordinator UI gets a `topology-page`
   status panel and a `settings-panel` token table.

## Usage

```bash
# Start the coordinator + a beacon, then:
pnpm --filter mcp-swarm run build
node mcp-swarm/bin/mcp-swarm
```

On first run the daemon mints a `default` token, prints the plaintext **once**,
and writes it to `<data-dir>/token` (mode `0600`).

Register it with an MCP client (e.g. Claude Code):

```jsonc
{
  "mcpServers": {
    "swarm": {
      "type": "http",
      "url": "http://127.0.0.1:3460/mcp",
      "headers": {
        "Authorization": "Bearer mcpsw_…",
      },
    },
  },
}
```

### Environment

| Variable                    | Default                    | Purpose                        |
| --------------------------- | -------------------------- | ------------------------------ |
| `MCP_SWARM_COORDINATOR_URL` | `http://127.0.0.1:3456`    | Coordinator to connect to.     |
| `MCP_SWARM_DATA_DIR`        | `~/.drone-agent/mcp-swarm` | Identity, TLS, token storage.  |
| `MCP_SWARM_ID`              | `mcp-swarm`                | Node id used for registration. |
| `MCP_SWARM_HOST`            | `127.0.0.1`                | HTTP bind host.                |
| `MCP_SWARM_PORT`            | `3460`                     | HTTP bind port.                |

## Auth tokens

Every `POST /mcp` needs `Authorization: Bearer mcpsw_…`. Tokens are **named**,
so each client can have its own, and any one can be revoked alone.

- The store keeps **only the SHA-256 hash** (`<data-dir>/tokens.json`, mode
  `0600`). The plaintext is shown **one time**, at creation.
- The coordinator UI's **Settings** page (`mcp-swarm` section) shows the token
  table and can create, rename, and revoke tokens.

## Capability catalog as the single source of truth

`src/mapping.ts` declares each capability once (name, description, param schema,
tier) and maps it to a coordinator REST request. The same catalog drives:

- the **MCP tools** this process serves (`src/mcp-server.ts`), and
- the **coordinator-proxied actions/tools** the coordinator routes to this node
  (the `invokeAction` / `invokeTool` WS commands, handled in `src/index.ts`).

The catalog has two **tiers**: `mcp` (visible to MCP clients) and `ui`
(coordinator UI only). `token.*` is `ui`-tier: it is hidden from `tools/list`
and rejected on both `tools/call` and the agent tool route.

## MCP transport

A stateless subset of the MCP streamable-HTTP transport:

| Method | Path | Answer                        |
| ------ | ---- | ----------------------------- |
| POST   | /mcp | 200 + JSON-RPC; 401 bad token |
| GET    | /mcp | 405 (no server→client stream) |
| DELETE | /mcp | 204 (no-op)                   |

There is no session id, no SSE on POST, and no resumability.

## Layout

| File                 | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `src/mapping.ts`     | Capability catalog (tiers) + coordinator REST mapping + executor.              |
| `src/mcp-server.ts`  | Transport-agnostic JSON-RPC handling (`initialize`/`tools/list`/`tools/call`). |
| `src/http-server.ts` | Stateless streamable-HTTP transport (auth, method routing, body cap).          |
| `src/token-store.ts` | Named-token store (SHA-256 at rest, 0600, atomic writes).                      |
| `src/bundle.ts`      | The embedded front-end bundle (`topology-page` + `settings-panel`).            |
| `src/index.ts`       | Wires the extension node, the token store, and the HTTP server.                |
| `bin/mcp-swarm`      | Executable shim.                                                               |

## Security

- **Local-only by default.** The daemon binds `127.0.0.1:3460` and speaks plain
  HTTP on loopback.
- If you must expose it wider, **use a private tailnet only** — never a public
  interface. Terminate TLS in front of the process; `mcp-swarm` does not
  terminate TLS itself.
- Tokens have **full power** (no per-token scopes) and **no expiry** in this
  version. Revoke a token if a client is retired.
