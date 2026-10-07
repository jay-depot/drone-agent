---
tags: [decision, swarm, prompt-fragments, beacon, coordinator, coordinator-ui, identity, adr]
related: [concepts/swarm-prompt-fragments.md, decisions/173-swarm-prompt-fragments.md, modules/drone-agent-plugins.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-swarm-common.md]
---

# 225 — Swarm Status + Swarm Identity prompt fragments (with coordinator-UI Identity page)

**Status**: Implemented (2026-09-26) · **Branch**: `feat/coordinator-status-prompts` · **Commits**: `7e8c9d4a` (feature) + memory `7e2e8280`, `2bb03c02` · **PR**: #113 · **Plan**: project-memory `plan-swarm-identity-status-fragments` — *deleted from project memory after ingest*

**Summary**: The `swarm` plugin gains two **header** system-prompt fragments. `# Swarm Status` (`swarm.status`) tells the model which swarm it runs in — the local beacon's name and dialed address, the coordinator host:port, and the roster of registered beacons — from a **cache-only** snapshot (no network in the render path). `# Swarm Identity` (`swarm.identity`) is **user-authored free text** describing the swarm's purpose, stored as a **reserved broadcast fragment** (`swarm-identity`) in the coordinator's `fragments` table and authored from a new coordinator-web-UI **Identity** page. The reserved id rides the existing coordinator→beacon-mirror→WS-`fragmentSync`→agent-store pipeline unchanged; the only new write machinery is a pair of coordinator authoring routes plus a `fragmentsChanged` reverse-channel nudge.

## Why

Before this, an agent had no idea which swarm it belonged to. It knew only the beacon URL it dialed; the beacon's own name was pushed outbound to the coordinator at registration but never served back, and the coordinator host lived only in beacon config. The status fragment gives the model situational awareness of the swarm topology; the identity fragment gives the operator one place to state the swarm's purpose/context to every agent at once, without a config-distribution key (which the narrow allowlist deliberately excludes `systemPrompt`-style content from).

## Locked design decisions (11)

1. **Identity reuses the fragment subsystem** as a reserved broadcast row (`id: 'swarm-identity'`, `target: 'broadcast'`, `phase: 'header'`) in the coordinator `fragments` table — no new table and no new transport. The Identity UI page is a thin client over one well-known id.
2. **Coordinator gains general write routes** `PUT /api/fragments/:id` and `DELETE /api/fragments/:id`, completing the deliberately deferred "authoring surfaces arrive with the persistent-WS rework" scaffolding (`routes/fragments.ts` had been read-only in v1 while `db/fragments.ts` already held the DB functions).
3. **New `fragmentsChanged` reverse-channel command**, distinct from `configChanged` so the two sync triggers stay distinguishable in logs; the beacon maps it to the same `triggerCoordinatorSync()`. The 5-minute periodic sync remains the correctness floor.
4. **Fragment validation moves to `drone-swarm-common`** (`fragments-limits.ts` extracted from the beacon, imported by both beacon and coordinator) so the caps/rules are identical on both write surfaces. `validateFragmentUpsert` gains a `scope` context field (beacon passes `'local'`, coordinator passes `'coordinator'`).
5. **Reserved fragments have their own budget**: `RESERVED_FRAGMENT_IDS` + `isReservedFragmentId()` + `countNonReserved()` live in the shared limits module; reserved rows are excluded from `MAX_BROADCAST_FRAGMENTS` (own budget), forced to `expiresAt: null` (never TTL-swept), and may only target `broadcast`.
6. **Beacon identity is served two ways, cached**: a new `GET /info` route returning `{ id, name, coordinatorHost, coordinatorPort }`, fetched at startup, **plus** the same payload pushed in the WS `connected` handshake so the cache self-heals after a beacon restart/reconfiguration.
7. **Roster is fetched** from the existing beacon proxy `GET /coordinator/beacons` on `onPluginsLoaded`, on every WS (re)connect, and on a 60 s interval; the last good roster is cached and **never regressed to an empty list** on a failed fetch. Render reads cache only.
8. **Agent renders three fragments in deterministic order** (the engine renders in registration order): `swarm.status` → `swarm.identity` → `fragments.header`. `SwarmFragmentStore.renderHeader()`/`renderFooter()`/`renderAll()` now **exclude reserved ids**, so the identity never double-renders under `# Swarm Fragments`.
9. **No new config keys**: both fragments are always-on when the swarm plugin is loaded (itself opt-in, `defaultEnabled: false`). Each hides itself (`false`) when it has no data.
10. **Coordinator-UI Identity page** (`/identity`, nav entry "Identity"): loads `GET /api/fragments?target=broadcast`, prefills a textarea, Save via `PUT`, Clear via a destructive-confirm `DELETE`, with a 16 KB byte counter and Save disabled when unchanged/empty/over-limit.
11. **Out of scope**: beacon-local identity overrides, per-agent identity, a rendered-section preview, an agent-side status tool, a general fragments UI page, `drone-swarm` CLI authoring, encryption-at-rest.

## Implementation

- `drone-swarm-common/src/fragments-limits.ts` — **moved** from `drone-beacon/src/fragments-limits.ts` (beacon's copy deleted). Adds `SWARM_IDENTITY_FRAGMENT_ID`, `RESERVED_FRAGMENT_IDS`, `isReservedFragmentId`, `countNonReserved`, and reserved-id handling inside `validateFragmentUpsert` (broadcast-only, cap-bypassing, forced non-expiring); the `ctx` gains `scope?: 'local' | 'coordinator'`. `drone-beacon/src/fragments-sweep.ts` now imports `TTL_SWEEP_INTERVAL_MS` from the shared module.
- `drone-beacon/src/beacon-info.ts` — **new leaf module** (`BeaconInfo` type + `getBeaconInfo`/`setBeaconInfo`). Leaf placement is deliberate: `ws-server` reads it and cannot import `routes/context` (which imports `ws-server`) without a cycle. Re-exported from `routes/context.ts` and `routes/index.ts`.
- `drone-beacon/src/routes/info.ts` — **new** `GET /info` (registered in `routes/index.ts`); `setBeaconInfo(...)` called in `index.ts` right after `setBeaconAddress`.
- `drone-beacon/src/ws-server.ts` — the `connected` handshake payload now carries `info: getBeaconInfo()`.
- `drone-beacon/src/coordinator-ws.ts` — new `fragmentsChanged` case beside `configChanged` (both call `triggerCoordinatorSync()`).
- `drone-beacon/src/routes/fragments.ts` — POST now passes `scope: 'local'` and counts via `countNonReserved`.
- `drone-coordinator/src/beacon-ws.ts` — new `notifyFragmentsChanged()` → `broadcastBeaconCommand('fragmentsChanged')`.
- `drone-coordinator/src/db/fragments.ts` — `upsertFragment` now preserves `createdAt` across updates and accepts an omitted `createdAt`/`scope` (always writes `scope: 'coordinator'`); input type is `Omit<DroneSwarmFragment, 'createdAt' | 'updatedAt' | 'scope'>` + optional `createdAt`/`scope`.
- `drone-coordinator/src/routes/fragments.ts` — adds `PUT /fragments/:id` (validate → upsert → `notifyFragmentsChanged`) and `DELETE /fragments/:id` (beacon-mirrored semantics: 404 when absent, 400 when ambiguous without `?target=`, `?target=` disambiguation); the "Read-only in v1" comment is gone.
- `drone-agent/src/plugins/swarm/swarm-info.ts` — **new**: `createSwarmInfoStore(localAddress)` (`applyBeaconInfo`/`replaceRoster`/`getInfo`/`getRoster`/`getLocalAddress`), `refreshSwarmInfo(store, baseUrl, logger)` (best-effort `/info` + `/coordinator/beacons`, failures keep last-known, non-array responses never regress the roster), `startSwarmInfoRefresh` (60 s, unref'd).
- `drone-agent/src/plugins/swarm/status-fragment.ts` + `identity-fragment.ts` — **new** fragment factories.
- `drone-agent/src/plugins/swarm/fragment-store.ts` — reserved ids excluded from the bucket renders; new `renderIdentity()` (`# Swarm Identity\n\n<content>`, `false` when absent).
- `drone-agent/src/plugins/swarm/context.ts` — `SwarmContext.swarmInfo` + a 5th `localAddress` ctor arg on `createSwarmContext`.
- `drone-agent/src/plugins/swarm/websocket.ts` — caches the pushed `info` in the `connected` branch and refreshes on `onopen`.
- `drone-agent/src/plugins/swarm/hooks.ts` — refreshes in `onPluginsLoaded`.
- `drone-agent/src/plugins/swarm/heartbeat.ts` — `registerShutdown` clears the new interval.
- `drone-agent/src/plugins/swarm/index.ts` — registers `status` → `identity` → `fragments.header` → `fragments.footer`; passes `localAddress` (`${beaconHost}:${beaconPort}`); starts the refresh interval next to `startHeartbeat`.
- `drone-coordinator-ui/src/lib/fragments.ts` — **new** mirrored constants (`SWARM_IDENTITY_FRAGMENT_ID`, `BROADCAST_TARGET`, `MAX_FRAGMENT_CONTENT_BYTES`), same convention as `lib/config-completions.ts` (the web package cannot import `drone-core`).
- `drone-coordinator-ui/src/lib/types.ts` — `SwarmFragment`.
- `drone-coordinator-ui/src/pages/identity.tsx` — **new** page (follows `config.tsx`'s patterns: `useAuthenticatedFetch`, `ErrorBanner`, `useToast`, `extractApiError`/`networkErrorMessage`).
- `drone-coordinator-ui/src/App.tsx` — `navItems` entry + `<Route path="/identity">`.
- Docs: `docs/agents/swarm-plugin.md` (agent-rendered-fragments table, both new sections, updated limits table, coordinator-scope/CLI notes) and `AGENTS.md` (swarm-plugin bullet).

**Deviations from the written plan:** the beacon-info state landed in the new leaf module `beacon-info.ts` rather than `routes/context.ts` (cycle avoidance, above); the coordinator `upsertFragment` input type omits `scope` with an optional override (matching the `replaceCoordinatorFragments` precedent); the plan's Step-4 `upsertFragment` snippet showed a `scope: 'coordinator'` literal in the type — the implementation widened it to `DroneSwarmFragment['scope']` to keep the `Omit` input assignable.

## Validation

LSP clean; `pnpm -r run build` **8/8 packages**; `pnpm lint:eslint` clean (one unused-import caught + fixed) + `lint:prettier` applied; `pnpm test` (root suite, matching CI) **3249 passed / 14 skipped / 0 failed**; `drone-coordinator-ui` suite **323 passed**. New tests: `drone-swarm-common/test/fragments-limits.test.ts` (11), `drone-beacon/test/info.test.ts` (3, incl. a real-WS handshake assertion), `drone-agent/test/swarm/swarm-info.test.ts` (5), `status-fragment.test.ts` (4), `websocket-info.test.ts` (2), `drone-coordinator-ui/src/pages/identity.test.tsx` (6), plus `coordinator-ws.test.ts` (+1), beacon `routes.test.ts` (+1 reserved-at-cap), agent `fragments.test.ts` (+3 store cases, +1 order test), coordinator `routes/fragments.test.ts` (rewritten, 11).

## Consequences

- A beacon with a coordinator configured now serves `GET /info`; the agent learns the beacon name and coordinator without any new config.
- The coordinator is no longer a read-only fragment surface — it accepts `PUT`/`DELETE /api/fragments/:id`. `swarm-identity` is the only reserved id today; the reserved-id mechanism is the extension point for future system-owned fragments.
- Reserved fragments no longer consume the broadcast cap, so the identity can always be saved even at the cap.
- `createSwarmContext` gained a required 5th argument (`localAddress`) and `registerShutdown` gained a required `swarmInfoInterval` argument — both swept across call sites and test mocks.

## Related

- swarm-prompt-fragments — the fragment subsystem this extends (reserved-id policy + coordinator authoring).
- [173-swarm-prompt-fragments](173-swarm-prompt-fragments.md) — the original fragment ADR (storage, delivery, caps).
- [drone-agent-plugins](../../drone-agent/src/plugins/) — the swarm plugin registration surface.
- [drone-beacon](../../drone-beacon/) — `GET /info`, `beacon-info.ts`, the `fragmentsChanged` handler.
- [drone-coordinator](../../drone-coordinator/) — fragment authoring routes + the nudge.
- [drone-coordinator-ui](../../drone-coordinator-ui/) — the Identity page.
- [drone-swarm-common](../../drone-swarm-common/) — the shared `fragments-limits.ts` + reserved-id policy.
