---
tags: [decision]
related:
  [
    254-swarm-extensions.md,
    237-serialize-file-tool-writes.md,
    211-beacon-coordinator-trust-hardening.md,
    198-coordinator-ui-launch-interact.md,
    concepts/swarm-prompt-fragments.md,
  ]
---

# 255 — mcp-swarm: streamable-HTTP transport + auth tokens

**Status**: Accepted (2026-10-16)

## Context

`mcp-swarm` (ADR [254](254-swarm-extensions.md) D16) was the reference swarm
extension: a **stdio** MCP server. Each MCP client started its own copy, and
every copy registered with the coordinator under the same node id — N processes,
one node, and no place to hold settings because each copy was short-lived.

Two things were wanted:

1. A **persistent process** that can hold state (settings) and serve a UI panel
   to the coordinator.
2. A way for an MCP client to authenticate — so a different person's agent on
   the same tailnet cannot use your swarm.

The pnpm/Node stack offered no need for a new HTTP dependency; `node:http`
suffices for the small, stateless surface required.

## Decision

### D1 — Tokens authenticate MCP clients; node identity stays mTLS

The token gate is **only** the `mcp-swarm` HTTP endpoint. The swarm-node
identity (registration, manifest, bundle upload) keeps using the existing
beacon mTLS path and is unchanged.

### D2 — Many named tokens, hashed at rest

A token entry is `{ id, name, createdAt, lastUsedAt?, hash }`. The store keeps
**only the SHA-256 hash**. The plaintext is shown **one time**, at creation. No
expiry in v1.

### D3 — Token format

`mcpsw_` + 32 random bytes as hex. Clients send `Authorization: Bearer mcpsw_…`.

### D4 — Bootstrap

If the store is empty on first run, the process mints **one** token named
`default`, prints the plaintext once, and writes it (mode `0600`) to a `token`
file in the data dir.

### D5 — Stateless streamable-HTTP transport

A stateless subset of the MCP streamable-HTTP transport. There is no
`Mcp-Session-Id`, no SSE on `POST`, no resumability, and no
`notifications/tools/list_changed` (the catalog is fixed at startup).

| Method | Path  | Auth         | Answer                                             |
| ------ | ----- | ------------ | -------------------------------------------------- |
| POST   | /mcp  | Bearer token | 200 + JSON-RPC result; 401 bad token; 400 bad JSON |
| GET    | /mcp  | Bearer token | 405 (no server→client stream)                      |
| DELETE | /mcp  | Bearer token | 204 (no-op)                                        |
| any    | other | none         | 404                                                |

A request with an `id` answers 200 + JSON. A request without an `id` (a
notification) answers 202 with no body. A body over 1 MiB answers 413.

### D6 — Auth on every POST, before parse

A bad or missing token answers **401** before the JSON-RPC body is parsed.

### D7 — Bind, transport, and scope

Default bind is `127.0.0.1:3460`. `MCP_SWARM_HOST` / `MCP_SWARM_PORT` change it.
Plain HTTP on loopback. The docs recommend a private tailnet for wider access;
TLS terminates in front of the process, never inside it.

### D8 — One transport: stdio is deleted

`startMcpStdioServer`, the Content-Length framing, and its parser are removed.
The bin boots the HTTP listener and runs as a daemon.

### D9 — Two capability tiers: `mcp` and `ui`

`DroneExtensionCapability` gains `exposed?: 'mcp' | 'ui'` (default `mcp`).
`mcp` capabilities are visible to MCP clients and agent-callable. `ui`
capabilities are for the coordinator UI only.

### D10 — `token.*` is UI-only

The four `token.*` capabilities (`list` / `create` / `revoke` / `rename`) are
`ui` tier. They are **hidden** from `tools/list` and **rejected** in
`tools/call`. The coordinator additionally rejects them on the agent tool route
with **403** `CAPABILITY_NOT_AGENT_CALLABLE`.

### D11 — The coordinator UI is in scope

The embedded bundle keeps the `topology-page` status panel and adds a
`settings-panel`: a token table (name, created, last used, Revoke) plus a Create
control that shows the plaintext once in a copy box.

### D12 — Token management flows through the coordinator action route

The settings panel calls
`POST /api/extensions/mcp-swarm/actions/token.*` (web-token auth) → the node
WS `invokeAction` command → a **local** handler in `mcp-swarm`. No new
coordinator surface.

### D13 — Shared crypto in `drone-swarm-common`

`generateToken`, `hashToken`, `verifyToken`, and `timingSafeEqualStrings` live
in `drone-swarm-common`. The coordinator web-token compare becomes
**constant time**; the LSP installer's private compare is deleted and imports
the same helper. The keyed lock (`withKeyLock` / `withPathLock`) also moves to
`drone-swarm-common` so the token store can reuse it.

### D14 — `node:http`, no new dependency

The transport uses `node:http`. No new dependency is added.

## Consequences

- One process, one node: the coordinator sees a single `mcp-swarm` registration,
  no matter how many MCP clients connect.
- The long-lived process holds the token store and serves a settings panel.
- Tokens give per-client access and per-client revocation.
- The MCP surface is unchanged for the three read tools; the new `token.*`
  capabilities are reachable only through the coordinator UI, not from an MCP
  client or an injected agent tool.
- The crypto helpers and the constant-time compare reduce duplicated, weaker
  comparison code across the workspace.

## Deferred

- TLS termination inside `mcp-swarm`.
- Per-token permissions or scopes (all tokens have full power).
- Token expiry.
- Server-sent events, session ids, resumability,
  `notifications/tools/list_changed`.
- Remote (non-tailnet) access and the ADR 254 pre-approval-token flow.
- Replatforming the gateway onto the extension protocol; refactoring the beacon
  onto `createExtensionNode`.
