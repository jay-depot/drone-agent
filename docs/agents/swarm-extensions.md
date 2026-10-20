# Swarm Extensions

A **swarm extension** is a beacon that declares a capability manifest. There is
one registry, one protocol, and one trust path: an extension connects to the
same `/ws/beacon` endpoint and registers through the same `POST /api/beacons`
as any beacon. "Extension" is a **role**, not a type — a node is an extension
iff it declares a manifest.

Extensions let an external service (on the same host, in v0):

- inject prompt fragments, one-shot system reminders, and **proxied tools** into
  agent sessions, and be **notified on agent session start**;
- do anything a beacon already can;
- register **proxied API actions** the coordinator serves as REST routes;
- ship a **front-end bundle** the coordinator UI loads.

See ADR [`254-swarm-extensions`](../adr/254-swarm-extensions.md) for the full
design (D1–D20).

## Protocol

### Registration

An extension registers exactly like a beacon (`POST /api/beacons`), advertising
`extension: { protocolVersion: 1 }` in the registration payload. On the primary
port the request is mTLS-authenticated with an Ed25519 identity + TLS cert. On
the unencrypted web port there is no client certificate, so the node id is
claimed and the coordinator trusts it because the port is bound to loopback
(ADR [257](../adr/257-extension-node-web-port-transport.md)).

### Transport

| Port            | Default                | Identity                | Has `/ws/beacon`? |
| --------------- | ---------------------- | ----------------------- | ----------------- |
| Primary (swarm) | 3456                   | mTLS client certificate | Yes               |
| Web             | 8080 (bound 127.0.0.1) | claimed node id         | Yes               |

An extension connects to the coordinator's **web port**, which is unencrypted
and bound to loopback. Registration from loopback is auto-approved, and the
reverse-channel socket claims its node id (via `?beaconId=` and the `x-node-id`
header).

The SDK does **not** implement the mTLS approval handshake
(`confirm-fingerprint` then operator approval). Pointing an extension at the
primary port (`https://…:3456`) leaves it pending forever. Use the web port.

### Manifest (over the reverse channel)

After connecting to `/ws/beacon`, the node sends a **manifest** frame:

```jsonc
{
  "type": "manifest",
  "protocolVersion": 1,
  "capabilities": [
    {
      "name": "swarm.session.list",
      "description": "List swarm agent sessions.",
      "paramSchema": { "type": "object", "properties": {} },
      "responseSchema": { "type": "object" },
      "timeoutMs": 15000,
      "exposed": "mcp",
    },
  ],
  "bundles": [{ "name": "status-panel", "version": "0.1.0", "hash": "…" }],
}
```

`protocolVersion` rides **both** the registration payload and the manifest
frame; a mismatch is logged and rejected in v0 (no negotiation). Manifests use
**replace semantics** — re-sending replaces the catalog.

### Capability tiers

Each capability carries an `exposed` tier, `'mcp' | 'ui'` (default `'mcp'`):

- **`mcp`** — visible to MCP clients (when the extension serves MCP) and
  callable as an agent tool.
- **`ui`** — a coordinator-UI-only capability. Hidden from MCP `tools/list` and
  rejected on the agent tool route with **403 `CAPABILITY_NOT_AGENT_CALLABLE`**.

The tier is advisory metadata; the enforcement lives in each extension's MCP
surface and in the coordinator's `invoke` (agent caller).

### Node → coordinator frames

| Frame           | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `manifest`      | Declare/replace the capability catalog + bundle list.      |
| `inject`        | Push an injection (`kind: fragment \| reminder \| tools`). |
| `inject-remove` | Remove a prior injection (by id, or drop all of a kind).   |
| `response`      | Reply to a command (`{ id, ok, status, body }`).           |

### Coordinator → node frames

| Frame     | Purpose                                                       |
| --------- | ------------------------------------------------------------- |
| `command` | `invokeAction` / `invokeTool` (UUID request/response).        |
| `event`   | `sessionStarted` / `sessionEnded` (non-blocking push to all). |

### Session lifecycle

On agent session registration the beacon forwards a **names-only snapshot**
(`sessionId, personaId, beaconId, interactive, isSubagent, cwd,
enabledPlugins[], mountedTools[], extensionHint?`) in the
`POST /api/sync/sessions/register` body; the coordinator persists it and pushes
`sessionStarted` to **every** node. On node connect the coordinator **replays**
`sessionStarted` for currently-active sessions so a restarted extension
recovers. `sessionEnded` fires on the existing end path.

First-turn race caveat: the push is non-blocking, so an extension that needs
turn-1 presence pushes at connect time.

## Injections

- **`fragment`** — persistent prompt content; `phase: 'header' | 'footer'`
  (default header, ordered after built-ins); optional `ttlMs`. Lives until
  removed, TTL expiry, session end, or extension disconnect.
- **`reminder`** — a one-shot system reminder (`_runtime.queueSystemReminder`).
- **`tools`** — a **selection** of catalog capabilities to expose as tools.

Agent state is an `ExtensionInjectionStore` keyed `(extensionId, injectionId)`
with its own `# Extension Injections` header fragment + footer bucket and a
per-extension per-session budget (~50 KB / 20 injections).

Transport: the coordinator resolves the host beacon from
`swarm_sessions.beacon_id` and sends `sendBeaconCommand(beaconId, 'inject', …)`;
the beacon relays `{ type: 'injection', payload }` to the target agent over its
WebSocket. The agent `extensions` plugin receives it through the swarm plugin's
generic `DroneSwarmCapability.registerWsHandler` seam.

## Proxied tools

A `tools` injection selects catalog capabilities; the coordinator resolves the
schema from the manifest (single source of truth) and the agent registers each
as `extensions__<extId>__<toolName>`, **unmounted** in the `ToolRegistry` (the
MCP pattern — the list/mount meta-tools and persona filters apply unchanged).

Tool call path (the agent never talks to the coordinator directly):

```
LLM calls extensions__<extId>__<toolName>
  → agent POSTs /coordinator/extensions/<extId>/tools/<toolName> on its beacon
  → beacon forwards to the coordinator (mTLS)
  → coordinator sendBeaconCommand(extId, 'invokeTool', { action, params, sessionId })
  → extension
  → { ok, status, body } returned verbatim → tool result
```

## Proxied API actions

`POST /api/extensions/:nodeId/actions/:action` (web-token / localhost auth)
enforces the action's `paramSchema` (400 on failure) and returns the node's
`{ ok, status, body }` verbatim. The official audience is front-end / external
consumers; agents use tool injection instead.

## Front-end bundles

Upload (mTLS-authenticated) via JSON + base64 file list:

```
PUT /api/extensions/bundles/:name
{ "version": "1.0.0", "files": [{ "name": "index.js", "contentBase64": "…", "contentType": "application/javascript" }] }
DELETE /api/extensions/bundles/:name
```

Served same-origin from the coordinator web port at
`/plugin-scripts/:nodeId/:hash/:name` (and `/plugin-styles/…`). The UI manifest
`GET /api/extensions` lists `{ nodeId, connected, capabilities, bundles: [{ name,
version, hash, scriptUrls, styleUrls }] }`.

The client contract mirrors the alice model: a bundle's `module.default` is
`{ regions?, routes?, onReady?(api) }`, with React shared via
`globalThis.React`. Bundles are loaded by dynamic `import()` — same-origin,
full page trust, no sandbox in v0.

**UI regions (v0):** `sidebar-nav`, `topology-widget`, `topology-card`,
`topology-page`, `sessions-widget`, `session-card`, `session-page`,
`settings-panel`. Arbitrary plugin routes (`{ path, title, component }`) are
allowed. The Topology page splits into **Beacons** and **Extensions**; the
**Settings** page hosts Coordinator Settings, Shared Agent Config (the moved
Config page), and one core-headed section per extension.

## Building an extension

Use the SDK in `drone-swarm-common`:

```ts
import { createExtensionNode } from 'drone-swarm-common';

const node = await createExtensionNode({
  coordinatorUrl: 'http://127.0.0.1:8080',
  dataDir: '/var/lib/my-ext',
  id: 'my-ext',
  name: 'My Extension',
  capabilities: [
    { name: 'my.thing', description: '…', paramSchema: { type: 'object' } },
  ],
  handlers: {
    onInvokeAction: async (cap, params) => ({
      ok: true,
      status: 200,
      body: {},
    }),
    onSessionStarted: snapshot => {
      node.injectFragment({
        target: snapshot.sessionId,
        id: 'ctx',
        content: '# Hello',
      });
    },
  },
});

await node.uploadBundle({ name: 'panel', version: '1.0.0', files: [/* … */] });
```

`node` exposes `injectFragment / injectReminder / injectTools /
removeInjection / declareManifest / uploadBundle / getFetch / stop`.

The reference implementation is the **`mcp-swarm`** workspace package: it
declares a small swarm catalog and exposes it to external MCP clients over
**streamable HTTP**, mapping each MCP tool 1:1 onto a catalog capability. It
runs as a long-lived daemon, guards its endpoint with **named auth tokens**, and
serves a **settings-panel** bundle for token management. See
[`mcp-swarm/README.md`](../../mcp-swarm/README.md) and ADR
[`255-mcp-swarm-http-transport-and-tokens`](../adr/255-mcp-swarm-http-transport-and-tokens.md).

## Gateway as an extension

`drone-gateway` uses this protocol to reach its coordinator. When
`coordinatorUrl` is set the gateway registers as an extension node and routes
**all** coordinator traffic through the node's mTLS `getFetch()`. The old
web-port-plus-Bearer-token path and its `coordinatorToken` config key are gone.

v0 is a **sender**: the node carries spawn and management requests, so the
gateway no longer needs a shared secret. It does **not** declare callable
capabilities or ship a front-end bundle — its manifest is
`{ protocolVersion: 1, capabilities: [], bundles: [] }`. The node is still an
extension because it declares a manifest.

```jsonc
// config.json
{
  "coordinatorUrl": "http://127.0.0.1:3456",
  "swarmExtension": {
    "id": "drone-gateway", // default
    "name": "Drone Gateway", // default
    "dataDir": "<configDir>/extension", // default; "~" expanded
    "requestTimeoutMs": 15000, // default; bounded coordinator fetch
  },
}
```

Behaviour:

- **Implicit gate.** `coordinatorUrl` presence enables the extension. Without
  it the gateway is a standalone chat agent runner. `coordinatorToken` is a
  removed key and a hard error when present.
- **Boot now.** The gateway serves conversations at once. Registration retries
  in the background (1 s to 30 s, without end), as does the WebSocket.
- **Not ready yet.** Until the node exists, coordinator requests reject with
  `coordinator unavailable: gateway extension node not connected`.
- **Bounded fetch.** A stalled coordinator rejects after
  `requestTimeoutMs` with `coordinator did not respond within <ms> ms`.
- **Extension hint.** Every spawned agent is stamped
  `drone-gateway:<conversationId>` — coordinator mode as
  `config.extensionHint`, local mode as `--extension-hint`. Stamp-only in v0.
- **Session events.** `sessionStarted` / `sessionEnded` are wired to debug logs;
  filtering by hint is the next phase.
- **Shutdown order.** Injection API → Gateway Engine (agents terminate over the
  live node) → node → exit.

See ADR
[`256-gateway-swarm-extension`](../adr/256-gateway-swarm-extension.md).

## Pre-approval tokens

A **pre-approval token** pre-approves a remote node. The user mints the token in
the coordinator UI, gives the token file to the node, and runs the node once
with `--pre-approval-token-path`. The node registers, redeems the token, and
exits. The coordinator marks the node approved. A later start of the same node
connects without manual work. See ADR
[`258-pre-approval-tokens`](../adr/258-pre-approval-tokens.md).

The token is a **sensitive credential**. The UI shows a warning and shows the
token one time only.

### The token file

```json
{
  "durableId": "3f2a…-uuid",
  "pubKey": "<coordinator Ed25519 public key, base64 SPKI>",
  "tlsFingerprint": "<coordinator TLS cert SHA-256, hex, no colons>",
  "burnKey": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "sig": "<base64 Ed25519 signature>"
}
```

### The flag

`mcp-swarm` and `drone-gateway` accept `--pre-approval-token-path` in both the
`=value` and the ` value` forms.

```
mcp-swarm --pre-approval-token-path=./token.json
drone-gateway --pre-approval-token-path ./token.json
```

With the flag the node performs a one-shot run: it registers, redeems the token,
writes the trust file, and exits 0. Without the flag it serves as usual.

### The trust file and pinning

The one-shot run writes `{coordinatorUrl, tlsFingerprint}` to
`<dataDir>/coordinator-trust.json` (mode `0600`). `createExtensionNode` reads
that file when it receives no explicit fingerprint. The node **pins** the
coordinator's TLS fingerprint, so there is no trust-on-first-use window. A
mismatch is refused.

## Constraints (v0)

- **Local-only**: same host as the coordinator. Remote extensions are deferred
  behind a future pre-approval token flow. Extensions connect to the
  coordinator's **web port** (unencrypted, loopback-only); see
  [ADR 257](../adr/257-extension-node-web-port-transport.md) for the accepted
  risks of trusting a claimed node id on that port.
- No sandbox for front-end bundles (same-origin, full page trust).
- A disconnected node → 503; a timeout (15 s default, per-capability override)
  → 504 / tool-error; no retry.
- The beacon refactor onto the SDK is deferred. The gateway is replatformed
  (ADR [256](../adr/256-gateway-swarm-extension.md)); the callee direction, tool
  and prompt injection, the gateway config UI, and remote extensions are
  deferred.
