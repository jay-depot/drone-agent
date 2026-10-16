---
tags: [decision]
related:
  [
    151-memory-pipeline-infra.md,
    173-swarm-prompt-fragments.md,
    179-swarm-memory-rag-retrieval.md,
    198-coordinator-ui-launch-interact.md,
    211-beacon-coordinator-trust-hardening.md,
    223-gateway-swarm-console-control-surface.md,
    234-gateway-external-process-injection.md,
    modules/drone-beacon.md,
    modules/drone-coordinator.md,
    concepts/swarm-prompt-fragments.md,
  ]
---

# 254 — Swarm extensions: beacons that declare a capability manifest

**Status**: Accepted (2026-10-13)

## Context

The swarm had exactly one kind of connected node: a **beacon**. An external
tool that wanted to participate (inject prompt context into agent sessions,
expose a proxied API, ship a coordinator-UI panel) had no supported path. It
could imitate a beacon only by reimplementing the beacon↔coordinator protocol,
and it could do none of the four things its authors need:

1. **Inject prompt fragments, one-shot system reminders, and proxied tools**
   into agent sessions, and be **notified on agent session start** with enough
   metadata to decide what to inject.
2. **Do anything a beacon already can** (register, receive commands, hold a
   trust record).
3. **Register proxied API actions** — name + param schema + response schema the
   coordinator serves as a REST route and proxies over the node's WebSocket.
4. **Send a bundle of front-end code** to the coordinator to run (the
   front-end-plugin architecture of `alice-assistant`).

The pieces mostly existed: `sendBeaconCommand(beaconId, command, payload,
timeoutMs)` is a UUID request/response primitive; the coordinator's inbound WS
handler is a one-line type gate; the fragment pipeline, the `ToolRegistry`
(unmounted by default), the `SystemReminderQueue`, and the beacon
`/coordinator/*` proxy all exist. What was missing was a **contract**.

## Decision

### D1 — One registry, one protocol, one trust path

An **extension is a beacon**. There is one registry, one protocol, one trust
path — the node is called a "beacon"; "swarm extension" is not a type but a
**role**: a beacon that declares a capability manifest. No `kind` field, no
parallel registry, no rename. Extensions connect to the same `/ws/beacon`
endpoint and register through the same `POST /api/beacons`.

### D2 — Manifests are dynamic; declaring one makes you an extension

Manifests are declared over the live WebSocket with **replace semantics**. A
node is an **extension iff it declares a manifest** (this is the UI-split rule
and the `/api/extensions/*` routing rule). Shape:

```jsonc
{
  "type": "manifest",
  "protocolVersion": 1,
  "capabilities": [
    { "name", "description", "paramSchema", "responseSchema", "timeoutMs?" }
  ],
  "bundles": [{ "name", "version", "hash", "targetRegions?" }]
}
```

`protocolVersion: 1` rides **both** the registration payload
(`POST /api/beacons`) and the manifest frame; a mismatch is logged and rejected
in v0 (no negotiation).

### D3 — Capability catalog declared up front

One capability **catalog** is declared up front in the manifest. No on-the-fly
naming, no inline ad-hoc definitions. Per-session tool injection is a
**selection** from the catalog (see D8/D9).

### D4 — Two coordinator invoke routes

`POST /api/extensions/:nodeId/actions/:action` (UI/external consumers,
web-token/localhost auth) and `POST /api/extensions/:nodeId/tools/:tool` (agent
tool calls, node mTLS via the beacon proxy). They will diverge in features, so
they are kept distinct. `paramSchema` is **enforced** (400 on failure);
`responseSchema` is **advisory**. Both proxy via
`sendBeaconCommand(nodeId, command, { action, params, caller, sessionId },
cap.timeoutMs ?? 15000)` and return the node's `{ ok, status, body }` verbatim.
The node distinguishes the caller via `caller: 'ui' | 'agent'` + `sessionId`.
The official audience of the action route is front-end/external consumers;
agents use tool injection instead (ungoverned unofficial use as a tool backend
is tolerated).

### D5 — Session-start/end is a non-blocking push to every node

The coordinator pushes a new node frame
`{ type: 'event', event: 'sessionStarted', session: {…} }` to **every** node
(beacons included; a future task-coordination/accounting announcement is
anticipated). Extensions decide asynchronously and push injections back. There
is no blocking await; the first-turn race is a documented caveat — an extension
that needs turn-1 presence pushes at connect time. `sessionEnded` is included,
fired on the existing end path. On node connect the coordinator **replays**
`sessionStarted` for currently-active sessions so a restarted extension
recovers.

### D6 — `sessionSnapshot` (names only)

The agent→beacon→coordinator registration payload expands to a versioned,
names-only snapshot carried in the existing `POST /api/sync/sessions/register`
body and persisted as a JSON column on `swarm_sessions`:

```jsonc
{
  "protocolVersion": 1, "sessionId", "personaId", "beaconId", "interactive",
  "isSubagent", "cwd", "enabledPlugins": [], "mountedTools": [], "extensionHint?"
}
```

A new optional `extensionHint` string identifies the session's origin; it is
set by a new CLI flag `--extension-hint <string>` (with a `DRONE_EXTENSION_HINT`
env fallback) and appended by the spawner like `--session-id`.

### D7 — Injection transport

An extension pushes `{ type: 'inject', id, target, kind, content, phase?,
ttlMs? }` inbound. The coordinator resolves the host beacon from
`swarm_sessions.beacon_id`, sends `sendBeaconCommand(beaconId, 'inject', …)`,
and the beacon relays `{ type: 'injection', payload }` to the target agent over
its agent WebSocket. Cleanup: extension disconnect ⇒ the coordinator commands
the beacon to drop that extension's injections for affected agents; plus
explicit removal frames and session-end clear. A session **recycle** drops
injections and re-pushes (the extension gets a fresh `sessionStarted`).

Agent state is a **new** `ExtensionInjectionStore` (not a reuse of
`SwarmFragmentStore`), keyed `(extensionId, injectionId)`, with its own
`# Extension Injections` header fragment + footer bucket registered **after**
the swarm fragments (so injected content is ordered after the built-ins).

### D8 — Injection kinds + budget

- `fragment` — persistent; `phase: 'header' | 'footer'` (default header);
  optional `ttlMs`; lives until removed / TTL / session end / disconnect.
- `reminder` — one-shot, via `_runtime.queueSystemReminder` (the
  guardrail-class reminder).
- `tools` — **name selections** from the catalog, replace-semantics per
  `(ext, session)`; removal via `inject-remove { kind: 'tools', tools: [...] }`
  or an empty list (drop all).

Budget ~50 KB / 20 injections per extension per session.

### D9 — Injected tools

A `tools` injection carries selections from the catalog; the coordinator
resolves the schema from the manifest (single source of truth) and the agent
registers each as `extensions__<extId>__<toolName>`, **unmounted** in the
`ToolRegistry` (the MCP pattern — the list/mount meta-tools and persona filters
apply unchanged; persona globs `!extensions__*`, `!extensions__alice__*`).

Tool call path (the agent never talks to the coordinator directly):

```
LLM calls extensions__<extId>__<toolName>
  → agent POSTs its beacon's /coordinator/extensions/<extId>/tools/<toolName>
  → beacon forwards to the coordinator (mTLS)
  → coordinator sendBeaconCommand(extId, 'invokeTool', { action, params, sessionId })
  → extension
  → { ok, status, body } returned verbatim → tool result
```

The beacon holds the in-flight proxied call in memory for the duration (no
durable state).

### D10 — New agent plugin `extensions`

A new built-in plugin `extensions` (separate from `swarm`) with a **HARD**
dependency on `swarm` (the plugin does nothing without something speaking the
beacon protocol). It registers its own injection store/fragment, the
`injection` WS frame handler, the extension tools, and the `execute` proxy path.

Visibility in v0 is a read-only `/extensions` slash command (`busyBehavior:
true`) plus `notice` conversation events on inject/remove — no widget.

The swarm plugin's agent-WebSocket seam gains a generic
`DroneSwarmCapability.registerWsHandler(type, handler)` so the `extensions`
plugin can receive `injection` frames without the swarm plugin knowing about
them.

### D11 — Packaging: SDK in `drone-swarm-common`

The SDK lives in **`drone-swarm-common`** (a new `extension-server` module): a
`createExtensionNode({ coordinatorUrl, dataDir, id, name, capabilities,
handlers: { onInvokeAction, onInvokeTool, onSessionStarted, onSessionEnded } })`
helper owning the mTLS client, identity + TLS generation, `POST /api/beacons`
registration, `/ws/beacon` connect/reconnect, manifest declaration, inbound
dispatch, and replies, returning `node.injectFragment / injectReminder /
injectTools / removeInjection / declareManifest / uploadBundle / getFetch /
stop`. The Ed25519 identity helper moves from `drone-beacon/src/identity.ts`
into `drone-swarm-common` (the beacon imports from the new home). There is no
new `drone-extension` package.

A new **types-only** package `drone-extension-ui-types` carries
`PluginClientExport`, `UIRegion`, `UIExtensionApi`, `PluginClientRoute` — not
`drone-core`, so bundle authors do not pull the whole core.

### D12 — Front-end bundles

Delivery is an HTTP upload from the node, mTLS-authenticated (or the localhost
exemption). Storage is coordinator disk, keyed by node id + content hash.
Serving is **same-origin** from the coordinator web port at a stable URL
(`/plugin-scripts/{nodeId}/{hash}/{name}`, plus `/plugin-styles/…`). The UI
manifest `GET /api/extensions` lists bundles with resolved `scriptUrls` /
`styleUrls`.

Isolation is same-origin dynamic `import()` (the alice model), full page trust,
**no sandbox in v0** (sandbox/iframe deferred). Multiple named bundles per node
are allowed. The client contract mirrors alice: `module.default` →
`{ regions?, routes?, onReady?(api) }`, with React shared via `globalThis.React`.

### D13 — Trust: local-only in v0

Extensions are **local-only** (same host as the coordinator). There is no
coordinator config toggle (an enable switch would be a "please break my setup"
toggle). The existing beacon trust path (mTLS + `beacon_trust.approved`) is
reused; no separate approval machinery. Remote extensions are **deferred** until
a future "pre-approval token" auth flow; at that point remote capability
features become "works by default". Because v0 is local-only, capability
manifest honoring/tightening and manifest-change audit UI are not needed in v0.

### D14 — Error semantics

A disconnected node → 503 immediately. A timeout (default 15 s, per-capability
override) → 504 (HTTP) / tool-error `extension did not respond` (agent). A
disconnect mid-call → reject (503 / tool-error), **no retry in v0**. An
`{ ok: false, status }` is passed through verbatim (the extension owns its error
semantics; the coordinator guarantees transport only).

### D15 — Coordinator UI front-end plugin system

Regions in v0: `sidebar-nav`, `topology-widget`, `topology-card`,
`topology-page`, `sessions-widget`, `session-card`, `session-page`,
`settings-panel`. Arbitrary plugin routes (`{ path, title, component }`) are
allowed.

There is **no separate extension management page**; instead the Topology page
splits into two sections: **Beacons** and **Extensions** (a node appears under
Extensions once it declares a manifest).

A real **Settings** page is created (nav entry): **Coordinator Settings**
(read-only) → **Shared Agent Config** (the moved Config page) → one
core-headed section per extension's `settings-panel`.

Extension authors get shared types (`drone-extension-ui-types`).

### D16 — Example/reference extension = `mcp-swarm`

A new in-tree workspace package **`mcp-swarm`** — an MCP proxy exposing swarm
functions to external MCP clients (Claude Code) — is the reference example and
the end-to-end acceptance fixture. The gateway is conceptually an extension but
is a poor example (it does far more than speak the API). The beacon is **not**
refactored onto the SDK in v0; the gateway replatform onto the extension
protocol is **deferred** (but will happen before the beacon refactor).

### D17 — Phasing

**P0** protocol + SDK (`drone-core`, `drone-swarm-common`, `drone-coordinator`,
`drone-beacon`) → **P1** agent `extensions` plugin (`drone-agent`) → **P2**
coordinator UI front-end plugin system (`drone-coordinator-ui`) → **P3** new
`mcp-swarm` workspace package → **P4** docs + ADR. P1 is blocked on P0; P2
mainly depends on P0.

## Consequences

- An external service becomes a first-class swarm participant by connecting to
  the same endpoint a beacon uses and declaring a manifest — no protocol
  reimplementation, no parallel registry, no new trust path.
- Extensions can inject prompt context (fragments + one-shot reminders) and
  proxied tools into agent sessions, notified on session start; the tool-call
  path respects "the agent never talks to the coordinator directly".
- Per-session tool sets are a projection of one catalog, so schemas have a
  single source of truth.
- The coordinator can serve and the UI can load extension front-end bundles
  same-origin (alice model), full page trust, no sandbox in v0.
- Extensions are local-only in v0; remote extensions wait on a pre-approval
  token flow. The beacon-onto-SDK refactor and the gateway replatform are
  deferred (the latter before the former).
- The first-turn race is a documented caveat.

## Deferred

- Remote extensions + the pre-approval-token auth flow.
- Replatforming the **gateway** onto the extension protocol.
- Refactoring **drone-beacon** onto `createExtensionNode`.
- Bundle sandboxing / iframe isolation.
- SPA-reload-on-plugin-route polish.
- Manifest-change audit-log UI.
