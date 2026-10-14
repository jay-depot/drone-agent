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

An extension registers exactly like a beacon (`POST /api/beacons`, mTLS,
Ed25519 identity + TLS cert). It additionally advertises
`extension: { protocolVersion: 1 }` in the registration payload.

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
      "paramSchema": { "type": "object", "properties": { } },
      "responseSchema": { "type": "object" },
      "timeoutMs": 15000
    }
  ],
  "bundles": [{ "name": "status-panel", "version": "0.1.0", "hash": "…" }]
}
```

`protocolVersion` rides **both** the registration payload and the manifest
frame; a mismatch is logged and rejected in v0 (no negotiation). Manifests use
**replace semantics** — re-sending replaces the catalog.

### Node → coordinator frames

| Frame           | Purpose                                                       |
| --------------- | ------------------------------------------------------------- |
| `manifest`      | Declare/replace the capability catalog + bundle list.         |
| `inject`        | Push an injection (`kind: fragment \| reminder \| tools`).    |
| `inject-remove` | Remove a prior injection (by id, or drop all of a kind).      |
| `response`      | Reply to a command (`{ id, ok, status, body }`).              |

### Coordinator → node frames

| Frame     | Purpose                                                        |
| --------- | -------------------------------------------------------------- |
| `command` | `invokeAction` / `invokeTool` (UUID request/response).         |
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
  coordinatorUrl: 'http://127.0.0.1:3456',
  dataDir: '/var/lib/my-ext',
  id: 'my-ext',
  name: 'My Extension',
  capabilities: [
    { name: 'my.thing', description: '…', paramSchema: { type: 'object' } },
  ],
  handlers: {
    onInvokeAction: async (cap, params) => ({ ok: true, status: 200, body: {} }),
    onSessionStarted: snapshot => {
      node.injectFragment({ target: snapshot.sessionId, id: 'ctx', content: '# Hello' });
    },
  },
});

await node.uploadBundle({ name: 'panel', version: '1.0.0', files: [/* … */] });
```

`node` exposes `injectFragment / injectReminder / injectTools /
removeInjection / declareManifest / uploadBundle / getFetch / stop`.

The reference implementation is the **`mcp-swarm`** workspace package: it
declares a small swarm catalog and exposes it to external MCP clients over
stdio, mapping each MCP tool 1:1 onto a catalog capability.

## Constraints (v0)

- **Local-only**: same host as the coordinator. Remote extensions are deferred
  behind a future pre-approval token flow.
- No sandbox for front-end bundles (same-origin, full page trust).
- A disconnected node → 503; a timeout (15 s default, per-capability override)
  → 504 / tool-error; no retry.
- The beacon refactor onto the SDK and the gateway replatform onto the
  extension protocol are deferred.
