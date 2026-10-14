---
key: plan-swarm-extensions
tags:
  - plan
  - swarm
  - extension
  - protocol
  - coordinator
  - beacon
  - agent
  - ui
  - sdk
created: 2026-10-13T23:31:34.330Z
updated: 2026-10-13T23:31:34.330Z
---

# Plan: Swarm Extensions

**Branch**: `feat/swarm-extensions` (created 2026-10-13, off `main` @ `18f021b7`)
**Status**: ready for execution. Next ADR number = **254**.

## Summary — what & why

**Swarm Extensions** are external services that connect to the coordinator over the **same protocol as beacons**. An extension _is_ a beacon that also declares a **capability manifest**; that single unification gives it "everything a beacon can do" for free, plus four new powers:

1. **Inject into agent sessions** — system-prompt fragments, one-shot system reminders, and "proxied tools", driven by a **session-start notification** carrying agent metadata.
2. **Do anything a beacon already can** (spawn, deliver messages, relay, sync) — free, because it _is_ a beacon.
3. **Expose proxied API actions** — declared with a param + response schema; the coordinator serves the REST route and proxies over the extension's WebSocket with a UUID tag, waiting for the reply.
4. **Ship front-end bundles** — code the coordinator stores and serves same-origin into its web UI as a "front-end plugin".

**Why**: this answers several open "how does the gateway manage remote agents" questions at once (the gateway is _conceptually_ a swarm extension), and opens end-user extension points. It reuses the existing beacon trust path (mTLS + `beacon_trust` + approval), the existing UUID request/response WS primitive (`sendBeaconCommand`), the existing fragment/prompt pipeline, the existing tool list/mount registry, and the alice-assistant front-end-plugin model.

**Scope guardrails (v0)**:

- Extensions are **local-only (same-host)**. Remote extensions are deferred until a future "pre-approval token" auth flow lands.
- **No** coordinator config toggle, **no** separate approval machinery, **no** `kind` field, **no** rename of "beacon".
- The beacon is **not** refactored onto the new SDK; the **gateway** is **not** replatformed (both deferred — gateway first, then beacon).

## Key facts established during exploration (verified against code)

- Coordinator reverse-channel WS: `drone-coordinator/src/beacon-ws.ts`. Coordinator→node frame `{type:'command', id, command, payload}`; node→coordinator `{type:'response', id, ok, status, body}`. Inbound handler is a one-line type gate (`if (msg.type !== 'response' || !msg.id) return;`) — adding an inbound frame type is trivial. `sendBeaconCommand(beaconId, command, payload?, timeoutMs=15000)` is the existing UUID request/response primitive (pendingRequests Map).
- Beacon WS client: `drone-beacon/src/coordinator-ws.ts` — `handleCommand` switch dispatches commands, replies with `{type:'response', ...}`.
- Registration = HTTP `POST /api/beacons` (`drone-coordinator/src/routes/beacons.ts`) with an mTLS client-cert-fingerprint anti-spoof check; also writes the `beacons` table. Trust state = `beacon_trust` (`status` pending|approved|rejected, `tls_fingerprint`, `verification_code`, `fingerprint_confirmed_at`). WS admission (`resolveBeaconWsAdmission`) requires `status === 'approved'`.
- Coordinator is a two-port Fastify app (`drone-coordinator/src/index.ts`): primary/API port (`buildApp({https, enableMtls:true})`, hosts `/ws/beacon` + `/api/*`) and web port (`buildApp({getToken})` + `attachUi()` hosting `/ws`, the SPA, and static `/assets/`). `registerRoutes` mounts every REST route under `/api` (`routes/index.ts`). `web-auth.ts` `PROTECTED_PREFIXES` already includes `/api` (web-token required for non-local callers; localhost/Tailscale bypass).
- `swarm_sessions` table: `id, persona_id, beacon_id, createdAt, updatedAt, status` (+ `interactive`). Migration pattern = idempotent `PRAGMA table_info` + `ALTER TABLE` (`db/init.ts`).
- Session registration path: agent → beacon `POST /agents` then beacon → coordinator `POST /api/sync/sessions/register` (`drone-beacon/src/routes/sync.ts`) → `client.registerSwarmSession(id, personaId, interactive)`.
- Agent-side swarm plugin: `drone-agent/src/plugins/swarm/` — `websocket.ts` holds the beacon WS `onmessage` switch; `index.ts` is the barrel (`createSwarmPlugin`), registers fragments (`swarm.status` → `swarm.identity` → `fragments.header` → `fragments.footer`) and offers one merged capability object (engine keeps ONE capability per plugin id). `context.ts` holds `SwarmContext`.
- Tool registry: `drone-core/src/tool-registry.ts` (`ToolRegistry`, tools start unmounted); engine meta-tools `runtime__list_tools`/`mount_tool`/`unmount_tool`. MCP plugin (`drone-agent/src/plugins/mcp/index.ts`) is the canonical deferred-mount + remote-call pattern.
- Prompt fragment rendering re-runs every round (`context-budget-service.ts`: `buildSystemMessages` header, `buildFooterMessages` joins footer fragments into ONE `<system-reminder>` message).
- System reminders: `drone-agent/src/runtime/system-reminders.ts` `SystemReminderQueue` (capped 8, one-shot, non-persisted) drained per iteration as `role:'user'` `<system-reminder>`; reached via `_runtime.queueSystemReminder`.
- Identity: `drone-beacon/src/identity.ts` `generateIdentity`/`loadOrCreateIdentity` (Ed25519, writes `beacon-identity.json`); TLS in `drone-swarm-common/src/tls.ts` (`loadOrCreateTlsIdentity`).
- `drone-swarm-common/src/index.ts` is a flat barrel of module re-exports; `spawner.ts` builds child argv (`--swarm --spawn-id --session-id --beacon-host --beacon-port --output-json [--persona] [--task] [--model] [--working-dir]`).
- CLI: `drone-agent/src/cli.ts` `parseCliArgs` (bare top-level flags) + a plugin-namespaced flag facility `--<pluginId>.<flag>`; env fallbacks `DRONE_SESSION_ID`/`DRONE_SUBAGENT_ID`.
- Coordinator UI: `drone-coordinator-ui/src/App.tsx` (static `navItems` + route table; providers `ToastProvider > AuthProvider > WebSocketProvider > BrowserRouter`); `hooks/use-auth.tsx` (`useAuthenticatedFetch`), `hooks/use-websocket.tsx` (shared WS pub/sub). No CSP/helmet; no plugin/registry/slot mechanism; `@fastify/static` locked to `dist/assets` with `prefix:'/assets/'`.
- alice-assistant model (`/home/unleet/Projects/alice-assistant/docs/plugin-web-ui.md`): server `/plugin-scripts/{id}-{name}` + `GET /api/extensions` manifest; client dynamic `import()` of the same-origin ESM bundle → `module.default` `{regions, routes, onAliceUIReady(api)}`; React via `globalThis.React`; bundles built with esbuild, react/react-dom externalized.

---

## Decisions (all settled)

- **D1** Node model: **one registry, one protocol, one trust path**. Extension = a beacon that declares a manifest. Keep the name "beacon". No `kind`, no rename.
- **D2** Manifests are **dynamic** (declared over the live WS; replace-semantics). A node is an "extension" **iff it declares a manifest**.
- **D3** Capability **catalog** declared up front in the manifest (`name, description, paramSchema, responseSchema, timeoutMs?`). No on-the-fly naming, no inline ad-hoc defs.
- **D4** Two coordinator invoke routes: `POST /api/extensions/:nodeId/actions/:action` (UI/external, web-token) and `POST /api/extensions/:nodeId/tools/:tool` (agent tool calls, mTLS via beacon proxy). `paramSchema` **enforced** (400); `responseSchema` **advisory**.
- **D5** Session-start notify = **non-blocking push** to **every** node; `sessionEnded` too. Coordinator replays `sessionStarted` to a just-connected node for active sessions. First-turn race is a documented caveat.
- **D6** `sessionSnapshot` (names only): `{ protocolVersion, sessionId, personaId, beaconId, interactive, isSubagent, cwd, enabledPlugins[], mountedTools[], extensionHint? }`. Forwarded by the beacon in `POST /api/sync/sessions/register`; persisted as a JSON column on `swarm_sessions`.
- **D7** Injection transport: extension → coordinator (inbound WS `inject`/`inject-remove`) → host beacon (`sendBeaconCommand(beaconId,'inject',payload)`) → agent WS `{type:'injection'}` → new agent-side `ExtensionInjectionStore`.
- **D8** Injection kinds: `fragment` (persistent, header default, ordered after built-ins, optional TTL), `reminder` (one-shot via `queueSystemReminder`), `tools` (name selections from the catalog, replace-semantics per (ext,session)). Budget ~50KB / 20 injections per extension per session.
- **D9** Injected tools named `extensions__<extId>__<toolName>`, registered **unmounted**; persona filters apply. `execute` proxies agent → beacon `/coordinator/extensions/<extId>/tools/<tool>` → coordinator → extension.
- **D10** New agent-side plugin `extensions` (HARD dep on `swarm`). Visibility = read-only `/extensions` command + `notice` events. No widget.
- **D11** SDK `createExtensionNode(...)` in **`drone-swarm-common`** (`extension-server` module). Ed25519 identity helper moves there. New types-only package **`drone-extension-ui-types`**.
- **D12** Front-end bundles: HTTP upload (JSON + base64 file list, mTLS-authed), stored on coordinator disk + a DB row, served **same-origin** (`/plugin-scripts/...`), loaded via `useExtensions` + dynamic `import()`, **no sandbox** in v0. Multiple named bundles per node.
- **D13** Trust: reuse the beacon trust path; **local-only** for v0; no config toggle. Remote deferred to a future pre-approval-token flow.
- **D14** Error semantics: disconnected node → 503; timeout (default 15s, per-capability override) → 504 / tool-error `extension did not respond`; disconnect mid-call → reject, **no retry**; `{ok:false,status}` passed through verbatim.
- **D15** UI: regions `sidebar-nav`, `topology-widget`, `sessions-widget`, `settings-panel`, `session-card`, `session-page`, `topology-card`, `topology-page` + arbitrary plugin routes. Topology page split into **Beacons** / **Extensions**. New **Settings page** (Coordinator Settings → Shared Agent Config → extension sections). Extension authors get shared types.
- **D16** Example/reference extension = new in-tree package **`mcp-swarm`**.
- **D17** Phasing: P0 protocol+SDK → P1 agent plugin → P2 UI → P3 `mcp-swarm` → P4 docs/ADR.

---

## Protocol reference (write this down; it is the contract)

**Node → coordinator, over the `/ws/beacon` WebSocket (inbound frames the coordinator now accepts):**

```
{ type: 'response',      id, ok, status?, body? }                    // existing (command replies)
{ type: 'manifest',      protocolVersion: 1, capabilities: [...], bundles: [...] }
{ type: 'inject',        id, target: agentId, kind: 'fragment'|'reminder'|'tools',
                         content?, phase?: 'header'|'footer', ttlMs?,
                         tools?: [{ capability: string }] }
{ type: 'inject-remove', target: agentId, kind, injectionId?, tools?: [{ capability }] }
```

Capability entry: `{ name, description, paramSchema, responseSchema, timeoutMs? }`.
Bundle entry: `{ name, version, hash, targetRegions? }`.

**Coordinator → node, over the same WS (outbound frames):**

```
{ type: 'command', id, command, payload }     // existing; now also command='invokeAction'|'invokeTool'|'inject'|'injectRemove'
{ type: 'event',   event: 'sessionStarted'|'sessionEnded', session: <sessionSnapshot> }
```

**Agent → beacon → coordinator session registration:**

```
POST /agents                      { id, personaId }
POST /api/sync/sessions/register  { id, personaId, beaconId, interactive, snapshot }
    snapshot = { protocolVersion:1, sessionId, personaId, beaconId, interactive,
                 isSubagent, cwd, enabledPlugins[], mountedTools[], extensionHint? }
```

**Extension HTTP surface (all under `/api`; web-token/localhost-protected unless noted):**

| Method + path                                                      | Purpose                                                                                 | Auth                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------- |
| `PUT /api/extensions/bundles/:name`                                | upload/replace a bundle (`{version, files:[{name,contentBase64,contentType}]}`)         | node mTLS              |
| `DELETE /api/extensions/bundles/:name`                             | remove a bundle                                                                         | node mTLS              |
| `GET /api/extensions`                                              | UI manifest `[{ nodeId, name, connected, protocolVersion, capabilities[], bundles[] }]` | web token              |
| `POST /api/extensions/:nodeId/actions/:action`                     | invoke a proxied API action                                                             | web token              |
| `POST /api/extensions/:nodeId/tools/:tool`                         | agent tool-call proxy                                                                   | node mTLS              |
| `GET /plugin-scripts/:nodeId/:hash/:name` (+ `/plugin-styles/...`) | serve bundle assets same-origin                                                         | none (like `/assets/`) |

**Coordinator tool-invoke route must also be reachable via the BEACON** at `POST /coordinator/extensions/:nodeId/tools/:tool` (beacon proxies to coordinator, same pattern as the existing `/coordinator/*` routes).

---

## Execution plan

> **Order**: P0 → P1 → P3 → P2 → P4. (P3 `mcp-swarm` before P2 UI, because P3 is the end-to-end acceptance test for P0+P1 and needs no UI; P2 UI is last so it can be validated against real bundles from P3. P2 depends only on P0, so it may be run in parallel with P1/P3 if desired.) Every step: run LSP (`lsp__get_diagnostics`) before moving on.

### Phase P0 — Protocol + SDK foundation

**P0.1 — Shared wire types (`drone-core`).**
Add `drone-core/src/extension-types.ts` and re-export from `drone-core/src/index.ts`:

```ts
export const EXTENSION_PROTOCOL_VERSION = 1;

export type DroneExtensionCapability = {
  name: string;
  description: string;
  paramSchema: Record<string, unknown>; // JSON Schema, enforced
  responseSchema?: Record<string, unknown>; // advisory
  timeoutMs?: number; // default 15000
};

export type DroneExtensionBundle = {
  name: string;
  version: string;
  hash: string;
  targetRegions?: string[];
};

export type DroneExtensionManifest = {
  protocolVersion: number;
  capabilities: DroneExtensionCapability[];
  bundles: DroneExtensionBundle[];
};

export type DroneSessionSnapshot = {
  protocolVersion: number;
  sessionId: string;
  personaId: string | null;
  beaconId: string;
  interactive: boolean;
  isSubagent: boolean;
  cwd: string;
  enabledPlugins: string[];
  mountedTools: string[];
  extensionHint?: string;
};
```

Also add `type: 'manifest' | 'inject' | 'inject-remove'` and `type: 'event'` frame unions if a shared frame-type module is preferred. Tests: a type-only compile check is unnecessary; cover behaviour in P0.3/P0.6.

**P0.2 — Move Ed25519 identity helper into `drone-swarm-common`.**

- Create `drone-swarm-common/src/identity.ts` with the contents of `drone-beacon/src/identity.ts` (`generateIdentity`, `loadOrCreateIdentity`, `getSigningKey`, `BeaconIdentity` — rename exported type to `SwarmNodeIdentity` for clarity, keep a `BeaconIdentity` alias to avoid churn), parameterising the identity filename (`beacon-identity.json` default; extensions pass `node-identity.json`).
- Add `export * from './identity.js';` to `drone-swarm-common/src/index.ts`.
- Delete `drone-beacon/src/identity.ts`; update its importers (`drone-beacon/src/index.ts`, `coordinator-client.ts`, `fingerprint-announce.ts`, and any test) to `import { … } from 'drone-swarm-common'`.
- Verify with `lsp__find_references` on `loadOrCreateIdentity` / `generateIdentity` that no importer remains.
- Tests: port the beacon's identity tests (if any) to `drone-swarm-common/test/identity.test.ts`; keep the same filenames/defaults so behaviour is unchanged.

**P0.3 — Coordinator: inbound frame handling + manifest registry.**

- `drone-coordinator/src/beacon-ws.ts`: extend the inbound `socket.on('message')` handler (and the test-only `_handleIncomingMessage`) to dispatch a small set of inbound frame types instead of only `response`:
  - `response` → existing pendingRequests resolver.
  - `manifest` → `extensionRegistry.setManifest(beaconId, manifest)` (reject/log on `protocolVersion` mismatch) → persist last-known to `extension_capabilities` → `publishMutationEvent({eventType:'extension.manifest', payload:{beaconId}})` (drives the UI refresh).
  - `inject` / `inject-remove` → forward to the host beacon of `target` (`resolveHostBeacon(target)` from `swarm_sessions.beacon_id`) via `sendBeaconCommand(beaconId,'inject',payload)`; log unknown target.
- New `drone-coordinator/src/extension-registry.ts`: in-memory `Map<nodeId, DroneExtensionManifest>`; `getManifest`, `setManifest`, `clearManifest` (called on WS `close`), `listExtensionNodeIds()`, `isExtension(nodeId)`.
- On WS `close` for a node id: `clearManifest(nodeId)`; then for every active session snapshot whose `extensionHint`/beacon mapping ties to injections from that node, issue `inject-remove` (see P0.7) — at minimum, `clearManifest` + a `notifyExtensionsChanged()` publish.
- Tests: `drone-coordinator/test/extension-ws.test.ts` — manifest admit/replace/reject-on-version; inject forwarded to host beacon (spy `sendBeaconCommand`); unknown target logged; disconnect clears the registry.

**P0.4 — Coordinator DB: session snapshot column + extension tables.**

- `drone-coordinator/src/db/init.ts`: add idempotent migration
  ```sql
  -- PRAGMA table_info(swarm_sessions) guard, then:
  ALTER TABLE swarm_sessions ADD COLUMN session_snapshot TEXT;
  CREATE TABLE IF NOT EXISTS extension_capabilities (
    node_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS extension_bundles (
    node_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
    hash TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, name)
  );
  ```
- `drone-coordinator/src/db/swarm-sessions.ts`: store/read `session_snapshot` (JSON string) on create/get/list; add `listActiveSessionSnapshots()`.
- New `drone-coordinator/src/db/extensions.ts`: `upsertCapabilityCache`, `getCapabilityCache`, `listCapabilityCache`, `upsertBundle`, `deleteBundle`, `listBundles(nodeId?)`.
- Tests: migration is idempotent (run twice); snapshot round-trips; bundle CRUD.

**P0.5 — Beacon: registration snapshot + `/coordinator/extensions/*` proxy.**

- `drone-beacon/src/routes/sync.ts`: accept `snapshot?: DroneSessionSnapshot` on `POST /sync/sessions/register`; pass through to the coordinator client.
- `drone-beacon/src/coordinator-client.ts`: `registerSwarmSession(id, personaId, interactive, snapshot?)` and a new `invokeExtensionTool(nodeId, tool, params, sessionId)`; POST to the coordinator `/api/sessions/register` (with snapshot) and `/api/extensions/:nodeId/tools/:tool`.
- New `drone-beacon/src/routes/extensions.ts`: `POST /coordinator/extensions/:nodeId/tools/:tool` → forwards to the coordinator via the client; registers in `routes/index.ts`.
- `drone-beacon/src/coordinator-ws.ts`: handle command `inject` → `handleInject(payload)` (new `drone-beacon/src/routes/extension-handlers.ts`) which calls `sendToAgent(target, {type:'injection', payload})`; reply `{ok,status,body}`.
- Tests: proxy route forwards; `inject` command reaches a fake agent socket; snapshot forwarded.

**P0.6 — Coordinator: extension REST surface + bundle storage/serving.**

- New `drone-coordinator/src/routes/extensions.ts` (mounted under `/api` in `routes/index.ts`):
  - `GET /extensions` — merge connected-node registry + last-known cache + bundles → UI manifest. `connected = isBeaconConnected(nodeId)`, `isExtension = registry.isExtension(nodeId)`.
  - `POST /extensions/:nodeId/actions/:action` — look up manifest capability; validate `params` against `paramSchema` (add a tiny JSON-Schema-subset validator, or reuse an existing one if present — grep first; else enforce `type`/`required`/`properties` minimally) → 400 on failure; `sendBeaconCommand(nodeId,'invokeAction',{action,params,caller:'ui'},cap.timeoutMs ?? 15000)`; map: not connected → 503, timeout → 504, else pass `{ok,status,body}` through (status defaults 200).
  - `POST /extensions/:nodeId/tools/:tool` — same but `caller:'agent'`, `sessionId` from the calling beacon (request header or query), and no web-token requirement (mTLS node auth); reject if `params` fail the schema.
  - `PUT /extensions/bundles/:name` — auth via client-cert fingerprint (`resolveBeaconIdByFingerprint`); body `{version, files:[{name,contentBase64,contentType}]}`; write files under `<coordinatorDataDir>/extension-bundles/<nodeId>/<name>/<hash>/`; compute `hash` (sha256 of the concatenated file bytes); upsert the DB row; return `{name,version,hash,urls}`.
  - `DELETE /extensions/bundles/:name` — remove disk dir + DB row.
- Serving (web app, `drone-coordinator/src/index.ts` `attachUi`): add routes
  ```
  GET /plugin-scripts/:nodeId/:hash/:name   → send the stored file (application/javascript, Cache-Control immutable)
  GET /plugin-styles/:nodeId/:hash/:name    → text/css
  ```
  Read the disk path from the `extension_bundles` row; 404 if absent. These are public (like `/assets/`).
- `publishMutationEvent` on manifest/bundle changes so the UI refreshes.
- Tests: `drone-coordinator/test/extensions-routes.test.ts` — manifest listing, action invoke success/400/503/504, tool invoke, bundle upload + serve + delete, path-traversal rejection (`name`/`nodeId` sanitised with the fragment-id-style regex).

**P0.7 — Coordinator: session-start/end events + injection-replay + injection fan-out.**

- On `POST /api/sync/sessions/register` (`drone-coordinator/src/routes/swarm.ts`) after storing the snapshot: broadcast `{type:'event', event:'sessionStarted', session: snapshot}` to **all connected nodes** (`broadcastBeaconCommand` variant that carries a payload — add `broadcastBeaconEvent(event, session)` in `beacon-ws.ts`).
- On session end (`DELETE /api/sync/sessions/:id` handler): broadcast `{type:'event', event:'sessionEnded', session:{sessionId, extensionHint?}}`; drop the snapshot.
- On node WS connect (`registerBeaconConnection`): replay `sessionStarted` for all currently-active local sessions (`listActiveSessionSnapshots()`).
- On node WS `close`: `clearManifest` + inject-remove for that node's injections (track per-node injected (target, injectionId) tuples in the registry so cleanup is exact).
- Tests: `sessionStarted` broadcast on register + replay on connect; `sessionEnded` on end; cleanup on disconnect.

**P0.8 — SDK `extension-server` module (`drone-swarm-common`).**
Create `drone-swarm-common/src/extension-server.ts` (+ barrel export):

```ts
export type ExtensionNodeHandlers = {
  onInvokeAction?: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
  onInvokeTool?: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
  onSessionStarted?: (snapshot: DroneSessionSnapshot) => void | Promise<void>;
  onSessionEnded?: (session: {
    sessionId: string;
    extensionHint?: string;
  }) => void | Promise<void>;
};

export async function createExtensionNode(opts: {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  name: string;
  capabilities: DroneExtensionCapability[];
  handlers?: ExtensionNodeHandlers;
}): Promise<ExtensionNode>;

// ExtensionNode:
//   injectFragment({ target, id, content, phase?, ttlMs? }): void
//   injectReminder({ target, content }): void
//   injectTools({ target, capabilities: string[] }): void
//   removeInjection({ target, kind, injectionId? }): void
//   declareManifest(manifest): void          // re-declare dynamically
//   uploadBundle({ name, version, files }): Promise<{hash, urls}>
//   stop(): Promise<void>
```

The helper: loads/creates the Ed25519 identity + TLS cert (`loadOrCreateIdentity` + `loadOrCreateTlsIdentity`, identity file `node-identity.json`); registers (`POST /api/beacons` with `publicKey`, `tlsFingerprint`, `fingerprintConfirmed:false`, plus `extension: { protocolVersion: 1 }`); opens the `/ws/beacon` WS with the client cert; on `open` sends the `manifest` frame; dispatches inbound `command` (`invokeAction`/`invokeTool`) to the handlers and replies `{type:'response', id, ok, status, body}`; dispatches inbound `event` to `onSessionStarted`/`onSessionEnded`; reconnects with backoff. Cross-check the TLS/identity helpers' exact signatures in `drone-swarm-common/src/tls.ts` and reuse them verbatim.

- Tests: `drone-swarm-common/test/extension-server.test.ts` — registration body shape, manifest frame on open, invoke dispatch + reply, event dispatch, reconnect, inject frame emission (use a fake WS).

**P0.9 — Spawner + spawn payload: `--extension-hint` forwarding.**

- `drone-swarm-common/src/spawner.ts`: read `configOverride.extensionHint` and append `['--extension-hint', value]` to `args` (mirror the `--persona`/`--working-dir` blocks).
- Coordinator `POST /api/spawn` (`routes/spawn.ts`) + `handleSpawnAgent` payload: pass `extensionHint` through into the spawner `config`.
- Tests: spawner argv includes `--extension-hint` when set, omits it otherwise.

### Phase P1 — Agent-side `extensions` plugin

**P1.1 — CLI flag + runtime exposure.**

- `drone-agent/src/cli.ts`: add `extensionHint?: string` to `CliOptions`, parse bare `--extension-hint <value>`, and default `options.extensionHint ??= process.env.DRONE_EXTENSION_HINT`.
- `drone-agent/src/index.tsx`: thread `extensionHint` into the engine/runtime options (like `swarmSpawned`), exposed as `_runtime.extensionHint`.
- Tests: `drone-agent/test/cli-extension-hint.test.ts` — flag, env fallback, absent.

**P1.2 — Snapshot assembly + registration.**

- `drone-agent/src/plugins/swarm/hooks.ts` `registerSwarmSession`: build the `DroneSessionSnapshot` (sessionId, personaId, beaconId=sessionId, interactive, isSubagent, cwd=`process.cwd()`, `enabledPlugins` from `registration.listPlugins().filter(p=>p.enabled).map(p=>p.id)`, `mountedTools` from `registration.listMountedTools().map(t=>t.name)`, `extensionHint` from `_runtime.extensionHint`, `protocolVersion:1`) and include it in the `POST /sync/sessions/register` body.
- Tests: snapshot shape; names-only (no schemas); flags reflected.

**P1.3 — Swarm capability: generic WS handler seam.**

- `drone-core/src/capabilities.ts`: extend `DroneSwarmCapability` with `registerWsHandler(type: string, handler: (payload: unknown) => void): () => void`.
- `drone-agent/src/plugins/swarm/websocket.ts`: keep a `Map<type, Set<handler>>` on `SwarmContext`; in `onmessage`, after the built-in branches, dispatch unknown `type`s to registered handlers (default branch → handlers, then log unknown).
- `drone-agent/src/plugins/swarm/index.ts` / `context.ts`: expose the seam through the offered capability.
- Tests: registered handler receives a custom frame.

**P1.4 — `extensions` plugin skeleton + injection store.**

- New `drone-agent/src/plugins/extensions/` with `index.ts` (`createExtensionsPlugin`), `context.ts`, `injection-store.ts`, `injection-fragment.ts`, `injection-handlers.ts`, `tools.ts`, `command.ts`. `metadata.id = 'extensions'`, `defaultEnabled: false`, dependencies `[ { id: 'swarm' } ]` (**hard**).
- `injection-store.ts`: `ExtensionInjectionStore` keyed `(extensionId, injectionId)`; per-extension budget (bytes + count); `applyFragment/applyRemove/applyToolSelection/clearExtension/clearAll`; render `renderHeader()` (`# Extension Injections`, ordered after built-ins by registering AFTER the swarm fragments) and `renderFooter()`.
- Register the plugin in `drone-agent/src/plugins/index.ts` `staticBuiltInPlugins`.
- Tests: store apply/remove/budget/clear; header/footer render.

**P1.5 — Wire up the plugin.**

- `index.ts` `register()`: `request<DroneSwarmCapability>('swarm')`; if present, `registerWsHandler('injection', handleInjection)`; register the header + footer fragments; register the `/extensions` slash command (`busyBehavior: true`, read-only listing of connected extensions, capabilities, injections, tools); emit `notice` events on inject/remove.
- `injection-handlers.ts`: handle `fragment`/`reminder`/`tools` payloads; `reminder` → `_runtime.queueSystemReminder`; `tools` → register `extensions__<extId>__<name>` unmounted (idempotent reconcile per the MCP pattern) via `registration.registerTool`.
- On `onSessionRecycle`: `clearAll()` (extensions re-inject on the fresh `sessionStarted`).
- Tests: `drone-agent/test/plugins/extensions/*.test.ts` — frame → store → fragment render; reminder queued; tool registered unmounted with the right canonical name; persona glob `!extensions__*` filters.

**P1.6 — Proxied tool execution.**

- `tools.ts`: each injected tool's `execute` POSTs to `${beaconUrl}/coordinator/extensions/${extId}/tools/${toolName}` (get `beaconUrl` from the swarm capability) with `{params, sessionId}`; parse `{ok,status,body}`; on non-2xx or network error return a **tool-error string** (never throw into the loop) — e.g. `extension did not respond` on timeout.
- Tests: success returns the body; timeout/503 produce an error string.

### Phase P3 — `mcp-swarm` reference extension

**P3.1 — Package scaffold.** New workspace package `mcp-swarm/` (`package.json` with `"name": "mcp-swarm"`, `bin` `mcp-swarm`, deps on `drone-swarm-common` + an MCP server SDK or hand-rolled stdio JSON-RPC — grep the mcp plugin for the protocol shape). Add to `pnpm-workspace.yaml` if packages are listed explicitly. `tsconfig.json` extending `tsconfig.base.json`.
**P3.2 — Extension + MCP server.** On start, `createExtensionNode(...)` with a capability catalog (e.g. `swarm.session.list`, `swarm.wiki.read`, `swarm.agent.list`), and serve MCP tools that map 1:1 onto those capabilities over stdio. Declare one small front-end bundle (a status panel) to exercise P2.
**P3.3 — Installable example.** README with a `~/.drone-agent/…` config example; used as the e2e acceptance fixture.

- Tests: unit-test the MCP↔extension mapping; an integration smoke test guarded like the existing swarm integration suites.

### Phase P2 — Coordinator UI front-end plugin system

**P2.1 — `globalThis.React` + loader + registry.**

- `drone-coordinator-ui/src/main.tsx`: assign `(globalThis as any).React = React; (globalThis as any).ReactDOM = ReactDOM;` before render.
- New `src/extensions/types.ts` (re-export from `drone-extension-ui-types`).
- New `src/extensions/useExtensions.tsx`: fetch `GET /api/extensions`, inject `<link>` per `styleUrls`, `await import(/* @vite-ignore */ scriptUrl)`, read `module.default` `{regions, routes, onReady}`, register into an `ExtensionContext`.
- New `src/extensions/ExtensionContext.tsx` + `RegionSlot` component.

**P2.2 — Regions.** Add `<RegionSlot region=…/>` at: sidebar nav (`sidebar-nav`), topology toolbar (`topology-widget`) + topology cards/pages (`topology-card`, `topology-page`), sessions toolbar (`sessions-widget`) + session cards/pages (`session-card`, `session-page`), settings (`settings-panel`). Render plugin routes in `App.tsx`'s `<Routes>`.

**P2.3 — Topology split + Settings page.**

- `src/pages/topology.tsx`: split into two sections, **Beacons** and **Extensions**, on one page.
- New `src/pages/settings.tsx` (nav entry "Settings"): sections in order **Coordinator Settings** (new, read-only), **Shared Agent Config** (move the existing config page content here), then one section per extension (`settings-panel`). Update `navItems`/route table in `App.tsx`.
- Extensions' headings are core-provided (a `<ExtensionSection title>` wrapper).

**P2.4 — Types package.** New `drone-extension-ui-types/` (types-only): `PluginClientExport`, `UIRegion`, `UIExtensionApi`, `PluginClientRoute`. Wire as a dependency of the UI package.

- Tests (jsdom + `@testing-library/react`): loader registers a fake bundle's region component; `RegionSlot` renders it; route registration; Topology split renders both sections; Settings section order.
- **Poll for rendered content; do not use fixed ticks** (see project principle).

### Phase P4 — Docs + ADR

**P4.1 — `docs/adr/254-swarm-extensions.md`** — record D1–D17, the protocol table, the trust rationale, and the deferred items (remote/pre-approval-token, gateway replatform, beacon-onto-SDK refactor, bundle sandbox, plugin-route reload polish).
**P4.2 — Docs.** New `docs/agents/swarm-extensions.md`; update `AGENTS.md` (package table + plugin list + a Swarm Extensions bullet), `CONTEXT-MAP.md`/`CONTEXT.md` if it lists packages, and the project wiki.
**P4.3 — Self-improvement** — log insights; check in memory/skills/insights (branch is a feature branch, so commit them).

---

## Dependencies / order

- P0.1 → P0.2 → (P0.3, P0.4) → P0.5 → P0.6 → P0.7 → P0.8 → P0.9 (all P0 first; P0.8 can start once P0.3–P0.7 stabilise).
- P1 depends on P0 (esp. P0.5, P0.7). P3 depends on P0+P1. P2 depends on P0 (P0.6 + P0.8) only — **may run in parallel** with P1/P3.
- P4 last.
- Recommended serial order: **P0 → P1 → P3 → P2 → P4**.

## Cross-cutting engineering rules (from project standards)

- After editing `drone-core` types, run `pnpm -r run build` before trusting LSP in dependent packages.
- When changing a shared interface (`DroneSwarmCapability`, `CoordinatorClient`, `SwarmContext`, engine options), **sweep every implementer, consumer, and test mock** (`lsp__find_references` + grep).
- Reuse `drone-swarm-common` helpers; do not duplicate TLS/identity/verification/spawner logic.
- Prefer `node:fs/promises`; serialise read-modify-write with `withKeyLock`/`withPathLock`.
- File budget: split at 750 lines, must split at 1000.
- New code needs unit tests; bug fixes need a reproducing test first.

## Final step — check the work against the validation criteria

**Step Z (last)**: walk every item in **Validation Criteria** below, run each command, and fix until all pass. Do not mark the plan complete until LSP, lint, build, and the fast suite are green.

## Validation Criteria

1. **LSP**: `lsp__get_diagnostics` reports **zero errors/warnings** across the whole workspace (including tests). Re-run after every phase.
2. **Dependency build before LSP checks**: `pnpm -r run build` passes with zero errors (required after any `drone-core` / `drone-swarm-common` type change).
3. **Typecheck**: `pnpm typecheck` passes (includes `tsc -p tsconfig.test.json`).
4. **Lint**: `pnpm run lint` (ESLint + Prettier) passes with zero errors. **Re-read all files after running it** (Prettier rewrites them).
5. **Fast tests**: `pnpm run test` passes (all suites green, zero failures).
6. **New tests exist** for: wire types (P0), manifest lifecycle + inject fan-out + `sessionStarted`/replay (P0.3/P0.7), extension REST surface incl. 400/503/504 + bundle path-traversal (P0.6), SDK (P0.8), spawner `--extension-hint` (P0.9), CLI flag (P1.1), snapshot shape (P1.2), WS handler seam (P1.3), injection store/handlers/tool registration + persona filter (P1.4–P1.6), `mcp-swarm` mapping (P3), UI loader/regions/settings order (P2).
7. **Behavioural acceptance (end-to-end)**: with a coordinator + beacon running locally, start the `mcp-swarm` extension; an agent session start delivers `sessionStarted`; the extension injects one fragment (visible in `# Extension Injections`), one reminder (appears once), and one tool selection (tool appears in `runtime__list_tools` unmounted, and a call round-trips through beacon→coordinator→extension and returns a result); an `invokeAction` round-trips over `POST /api/extensions/:nodeId/actions/:action`; a bundle uploaded via `PUT /api/extensions/bundles/:name` is served at `/plugin-scripts/...` and rendered by the UI; the Topology **Extensions** section lists the node.
8. **No dead code / no fluff comments / no duplicated logic**; files under the size budget.
9. **ADR 254** written; `AGENTS.md` + `docs/agents/swarm-extensions.md` updated; plan memory updated with a `status`/outcome note when done.

## Deferred (explicitly out of scope for this plan)

- Remote extensions + the pre-approval-token auth flow.
- Replatforming the **gateway** onto the extension protocol (happens before the beacon refactor).
- Refactoring **drone-beacon** onto `createExtensionNode`.
- Bundle sandboxing / iframe isolation.
- SPA-reload-on-plugin-route polish (unformatted-JSON edge case).
- Manifest-change audit-log UI.

---

## Outcome (2026-10-13) — COMPLETE

All phases P0–P4 executed on `feat/swarm-extensions` (off `main` @ `18f021b7`).
Every validation criterion passes: `pnpm -r run build` ✓, `pnpm typecheck`
(`tsc -p tsconfig.test.json`) ✓, `pnpm run lint` ✓, `pnpm run test` ✓
(4125 passed / 16 skipped), LSP zero diagnostics.

**Shipped**
- Wire types (`drone-core/src/extension-types.ts`), Ed25519 identity helper moved
  to `drone-swarm-common/src/identity.ts` (P0.1/P0.2).
- Coordinator: inbound `manifest`/`inject`/`inject-remove` dispatch + in-memory
  `extension-registry.ts`; `swarm_sessions.session_snapshot` + `extension_capabilities`
  + `extension_bundles` tables; `extension-bundles.ts` storage; `/api/extensions*`
  REST surface + `bundle-serving.ts` same-origin `/plugin-scripts` `/plugin-styles`;
  `sessionStarted`/`sessionEnded` broadcast + connect replay (P0.3–P0.7).
- Beacon: registration `snapshot` forward, `/coordinator/extensions/:nodeId/tools/:tool`
  proxy, `inject`/`injectRemove` → agent WS (P0.5).
- SDK `createExtensionNode` in `drone-swarm-common/src/extension-server.ts`
  (+ shared `coordinator-fetch.ts`); spawner `--extension-hint` (P0.8/P0.9).
- Agent: `--extension-hint`/`DRONE_EXTENSION_HINT` → `_runtime.extensionHint`;
  session snapshot assembly; `DroneSwarmCapability.registerWsHandler` seam;
  new `extensions` plugin (injection store, handlers, proxied tools,
  `/extensions` command, `# Extension Injections` fragment) (P1.1–P1.6).
- `mcp-swarm` reference extension package (capability catalog → coordinator REST,
  dependency-free MCP stdio server, embedded status-panel bundle) (P3).
- Coordinator UI front-end plugin system: `globalThis.React`, loader/registry/
  `RegionSlot`/`ExtensionSections`, regions, Topology Beacons/Extensions split,
  new Settings page, types-only `drone-extension-ui-types` (P2).
- ADR 254 + `docs/agents/swarm-extensions.md`; AGENTS.md / CONTEXT-MAP.md /
  CONTEXT.md updated; project wiki pointer stub + indexes (P4).

**Deviations / notes**
- P2 ran after P3 (plan recommended P0→P1→P3→P2→P4; followed).
- `extensions` plugin `defaultEnabled: false` with a HARD `swarm` dep.
- UI region slots degrade gracefully without an `ExtensionProvider` (EMPTY
  default context) so focused page tests need no provider.
- The bundle loader was extracted to a pure `loader.ts` (injected `importModule`)
  for unit-testability.
- Pre-existing flaky test (not introduced): `drone-coordinator-ui` sessions
  "debounces an event burst" fails intermittently on the stashed baseline too.
- Remote extensions, gateway replatform, beacon-onto-SDK refactor, bundle
  sandboxing, and manifest-audit UI remain deferred (per the plan).
