---
key: plan-swarm-identity-status-fragments
tags:
  []
created: 2026-09-26T21:15:01.143Z
updated: 2026-09-26T21:15:01.143Z
---

# Plan: Swarm Status + Swarm Identity prompt fragments (with coordinator-UI Identity page)

## Summary

The `swarm` plugin (drone-agent) gains two new **header** system-prompt fragments:

1. **`# Swarm Status`** — describes the connected swarm: the local beacon's name (and the address the agent dialed), the coordinator host:port, and the roster of registered beacons.
2. **`# Swarm Identity`** — a **user-authored free-text** block, editable from a new page in the coordinator web UI.

Why: agents currently have no idea which swarm they run in or what it is for. The status fragment gives the model situational awareness (which beacons exist, where the coordinator is); the identity fragment gives the operator one place to state the swarm's purpose/context to every agent at once.

## Locked design decisions (all confirmed with the user)

- **Identity storage = reuse the coordinator `fragments` table** as a reserved broadcast fragment with id `swarm-identity`, `phase: 'header'`, `target: 'broadcast'`. No new table, no new transport: the existing coordinator → beacon mirror → WS `fragmentSync` → agent `SwarmFragmentStore` path delivers it.
- **Coordinator gains general fragment write routes** (`PUT /api/fragments/:id`, `DELETE /api/fragments/:id`), completing the deliberately deferred "authoring surfaces arrive with the persistent-WS rework" scaffolding (`drone-coordinator/src/routes/fragments.ts` is read-only today; `db/fragments.ts` has the DB functions ready). The Identity page is a thin client over one well-known id.
- **New `fragmentsChanged` reverse-channel command** (distinct from `configChanged` so the two sync triggers are distinguishable in logs); the beacon maps it to the same `triggerCoordinatorSync()`. The 5-minute periodic sync remains the correctness floor.
- **Fragment validation moves to `drone-swarm-common`** (`fragments-limits.ts` is extracted from the beacon and imported by both beacon and coordinator) so the caps/rules are identical on both write surfaces. `validateFragmentUpsert` gains a `scope` parameter (beacon passes `'local'`, coordinator passes `'coordinator'`).
- **Reserved fragments have their own budget**: `RESERVED_FRAGMENT_IDS` + `isReservedFragmentId()` live in the shared limits module; reserved rows are excluded from `MAX_BROADCAST_FRAGMENTS` and forced to `expiresAt: null` (never TTL-swept). Reserved ids may only target `broadcast`.
- **Beacon identity is served two ways, cached**: a new `GET /info` route returning `{ id, name, coordinatorHost, coordinatorPort }`, fetched at registration, **plus** the same payload pushed in the WS `connected` handshake so the cache self-heals after a beacon restart/reconfig.
- **Roster is fetched** from the existing beacon proxy `GET /coordinator/beacons` on `onPluginsLoaded`, on every WS (re)connect, and on a 60s interval; the last good roster is cached and never regressed to empty on a failed fetch. Prompt rendering reads cache only (never the network).
- **Agent renders three fragments in deterministic order** (engine renders in registration order): `swarm.status` → `swarm.identity` → `fragments.header`. `SwarmFragmentStore.renderHeader()` is changed to **exclude reserved ids** so identity does not double-render under `# Swarm Fragments`.
- **No new config keys**; both fragments are always-on when the swarm plugin is loaded (which is itself opt-in, `defaultEnabled: false`). Each hides itself when it has no data.
- **Out of scope**: beacon-local identity overrides, per-agent identity, a rendered-section preview in the UI, an agent-side tool to read swarm status, a general fragments page in the UI, `drone-swarm` CLI authoring, encryption-at-rest.

## Context (verified by exploration)

- `DroneSwarmFragment` wire type: `drone-core/src/swarm-fragment-types.ts` (id, target, content, phase, scope, createdAt, updatedAt, expiresAt; `BROADCAST_TARGET = 'broadcast'`; `validateFragmentId`).
- Beacon write path + caps: `drone-beacon/src/fragments-limits.ts`, `drone-beacon/src/routes/fragments.ts`; DB in `drone-beacon/src/db/fragments.ts` (`upsertFragment`, `listFragments({target,scope})`, `deleteFragment`, `replaceCoordinatorFragments`, `listMergedForAgent`, `mergedContentHash`, `deleteExpiredFragments`).
- Beacon sync: `drone-beacon/src/routes/context.ts` (`setBeaconAddress`, `triggerCoordinatorSync`, `getCoordinatorClient`), pulls `fetchCoordinatorFragments()` via `drone-beacon/src/coordinator-client.ts`.
- Beacon WS connect: `drone-beacon/src/ws-server.ts` (~line 374 sends `fragmentSync`, ~406 sends `connected` with `{ agentId }`).
- Beacon reverse-channel dispatch switch: `drone-beacon/src/coordinator-ws.ts` (~line 200, `case 'configChanged'`).
- Coordinator: read-only `drone-coordinator/src/routes/fragments.ts`; DB `drone-coordinator/src/db/fragments.ts`; nudge helpers `drone-coordinator/src/beacon-ws.ts` (`broadcastBeaconCommand`, `notifyConfigChanged`); routes mounted under `/api` in `drone-coordinator/src/routes/index.ts`.
- Agent swarm plugin: `drone-agent/src/plugins/swarm/index.ts` (registers `fragments.header`/`fragments.footer`), `context.ts` (`SwarmContext`, `createSwarmContext`), `fragment-store.ts` (`createSwarmFragmentStore`), `websocket.ts` (WS message handling + reconnect), `hooks.ts` (`onPluginsLoaded`), `heartbeat.ts` (`registerShutdown`), `memory-fragment.ts` (the fragment-factory pattern imported from `drone-swarm-common`).
- UI: `drone-coordinator-ui/src/App.tsx` (`navItems` + `<Routes>`), `src/pages/config.tsx` (the page pattern: `useAuthenticatedFetch`, `ErrorBanner`, `useToast`, `extractApiError`/`networkErrorMessage`), `src/lib/types.ts`, `src/pages/config.test.tsx` (test pattern).

---

## Step 1 — Extract fragment validation to `drone-swarm-common` + reserved-id policy — **coder**

**Files**
- NEW `drone-swarm-common/src/fragments-limits.ts` (moved from `drone-beacon/src/fragments-limits.ts`)
- EDIT `drone-swarm-common/src/index.ts` (add `export * from './fragments-limits.js';`)
- DELETE `drone-beacon/src/fragments-limits.ts`

**Changes**
- Move the module verbatim, then add:

```ts
export const SWARM_IDENTITY_FRAGMENT_ID = 'swarm-identity';
export const RESERVED_FRAGMENT_IDS: readonly string[] = [SWARM_IDENTITY_FRAGMENT_ID];

export function isReservedFragmentId(id: string): boolean {
  return RESERVED_FRAGMENT_IDS.includes(id);
}

/** Count fragments excluding system-reserved ids (reserved rows have their own budget). */
export function countNonReserved(fragments: Array<{ id: string }>): number {
  return fragments.filter(f => !isReservedFragmentId(f.id)).length;
}
```

- `validateFragmentUpsert(body, ctx)`: extend `ctx` with `scope?: 'local' | 'coordinator'` (default `'local'`; used for `normalized.scope` instead of the hardcoded `'local'`). After the id check, add:

```ts
if (isReservedFragmentId(raw.id)) {
  if (raw.target !== BROADCAST_TARGET) {
    return { ok: false, error: `Reserved fragment id "${raw.id}" may only target ${BROADCAST_TARGET}`, code: 'validation' };
  }
  return { ok: true, normalized: { id: raw.id, target: raw.target, content: raw.content, phase, scope, expiresAt: null } };
}
```

(Reserved rows skip the count caps entirely and are forced non-expiring. Non-reserved rows behave exactly as today.)

**Tests** (NEW `drone-swarm-common/test/fragments-limits.test.ts`): move/port the beacon's existing `validateFragmentUpsert` cases; add cases for `isReservedFragmentId`, `countNonReserved`, reserved-target enforcement, reserved TTL forcing, reserved cap bypass, and the `scope` parameter.

**Dependency**: none. **Blocks**: steps 3 and 4.

---

## Step 2 — Beacon: `GET /info` + WS identity handshake — **coder**

**Files**
- EDIT `drone-beacon/src/routes/context.ts` — add beacon-identity state + accessors:

```ts
export type BeaconInfo = {
  id: string;
  name: string;
  coordinatorHost: string | null;
  coordinatorPort: number | null;
};

let beaconInfo: BeaconInfo = { id: 'unknown', name: 'unknown', coordinatorHost: null, coordinatorPort: null };

export function setBeaconInfo(info: BeaconInfo) { beaconInfo = info; }
export function getBeaconInfo(): BeaconInfo { return beaconInfo; }
```

- NEW `drone-beacon/src/routes/info.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { getBeaconInfo } from './context.js';

export default function infoRoutes(app: FastifyInstance) {
  app.get('/info', async () => getBeaconInfo());
}
```

- EDIT `drone-beacon/src/routes/index.ts` — `import info from './info.js';` + `info(app);`
- EDIT `drone-beacon/src/index.ts` — right after `setBeaconAddress(...)` (~line 345):

```ts
setBeaconInfo({
  id: config.beaconId,
  name: config.beaconName,
  coordinatorHost: config.coordinatorHost ?? null,
  coordinatorPort: config.coordinatorPort ?? null,
});
```

- EDIT `drone-beacon/src/ws-server.ts` (~line 406) — add `info` to the `connected` payload:

```ts
socket.send(JSON.stringify({ type: 'connected', payload: { agentId, info: getBeaconInfo() } }));
```

**Tests** (`drone-beacon/test/routes-info.test.ts` or the existing route-test harness): `/info` returns the set identity, defaults to `unknown` when unset; WS `connected` payload carries `info`.

**Dependency**: none. **Blocks**: step 5 (agent caching).

---

## Step 3 — Beacon: `fragmentsChanged` command + shared-limits import — **coder**

**Files**
- EDIT `drone-beacon/src/coordinator-ws.ts` — add a case beside `configChanged` in the command switch:

```ts
case 'fragmentsChanged': {
  void triggerCoordinatorSync().catch(err => {
    logger.warn(`fragmentsChanged sync failed: ${err}`);
  });
  break;
}
```

- EDIT `drone-beacon/src/routes/fragments.ts` — import `validateFragmentUpsert`/`countNonReserved` from `drone-swarm-common` (file deleted in step 1) and pass `scope: 'local'` + reserved-excluding counts:

```ts
const result = validateFragmentUpsert(request.body, {
  scope: 'local',
  countBroadcasts: () => countNonReserved(db.listFragments({ target: 'broadcast' })),
  countTargetedForAgent: target => countNonReserved(db.listFragments({ target })),
});
```

**Tests**: beacon reverse-channel test asserting `fragmentsChanged` triggers a sync; beacon fragment route test asserting the reserved id can be written under `broadcast` even at the 5-broadcast cap.

**Dependency**: step 1. **Blocks**: end-to-end delivery.

---

## Step 4 — Coordinator: fragment authoring routes + nudge — **coder**

**Files**
- EDIT `drone-coordinator/src/beacon-ws.ts`:

```ts
/** Nudge every connected beacon to re-pull coordinator fragments immediately. */
export function notifyFragmentsChanged(): void {
  broadcastBeaconCommand('fragmentsChanged');
}
```

- EDIT `drone-coordinator/src/db/fragments.ts` — make `upsertFragment` preserve `createdAt` on update and accept an omitted one (mirror the beacon's signature):

```ts
export function upsertFragment(
  fragment: Omit<DroneSwarmFragment, 'createdAt' | 'updatedAt'> & { createdAt?: number }
): DroneSwarmFragment {
  const now = Date.now();
  const existing = getFragment(fragment.id, fragment.target);
  const row: DroneSwarmFragment = { ...fragment, scope: 'coordinator', createdAt: existing?.createdAt ?? fragment.createdAt ?? now, updatedAt: now };
  // INSERT ... ON CONFLICT(id, target) DO UPDATE SET content/phase/scope/updatedAt/expiresAt (createdAt NOT updated)
}
```

- EDIT `drone-coordinator/src/routes/fragments.ts` — add `PUT /fragments/:id` and `DELETE /fragments/:id`:

```ts
app.put<{ Params: { id: string }; Body: unknown }>('/fragments/:id', async (request, reply) => {
  const body = { ...(request.body as Record<string, unknown>), id: request.params.id };
  const result = validateFragmentUpsert(body, {
    scope: 'coordinator',
    countBroadcasts: () => countNonReserved(db.listFragments({ target: BROADCAST_TARGET })),
    countTargetedForAgent: target => countNonReserved(db.listFragments({ target })),
  });
  if (!result.ok) return reply.code(400).send({ error: result.error, code: result.code });
  const fragment = db.upsertFragment(result.normalized);
  notifyFragmentsChanged();
  return reply.code(200).send({ ok: true, fragment });
});

app.delete<{ Params: { id: string }; Querystring: { target?: string } }>('/fragments/:id', async (request, reply) => {
  // mirror the beacon's semantics: 404 when absent; require ?target= when the id exists under multiple targets
  // on success: notifyFragmentsChanged(); return { ok: true }
});
```

Remove the "Read-only in v1" comment; keep `GET /fragments` unchanged. The route file is mounted under `/api` already.

**Tests** (`drone-coordinator/test/routes-fragments.test.ts`): PUT upsert (create then update preserves `createdAt`, sets `scope: 'coordinator'`), validation rejections, reserved id targeting `broadcast`, DELETE semantics (404, ambiguous-target 400, `?target=` disambiguation), and that both fire `notifyFragmentsChanged` (`drone-coordinator/test/beacon-ws.test.ts` for the helper).

**Dependency**: step 1.

---

## Step 5 — Agent: swarm-info cache, status fragment, identity fragment, store reserved handling — **coder**

**Files**
- NEW `drone-agent/src/plugins/swarm/swarm-info.ts` — pure cache + best-effort refresh:

```ts
export type BeaconInfo = { id: string; name: string; coordinatorHost: string | null; coordinatorPort: number | null };
export type RosterEntry = { id: string; name: string; host: string; port: number; connected: boolean; trustStatus: string | null };

export class SwarmInfoStore {
  constructor(private readonly localAddress: string) {}
  applyBeaconInfo(info: BeaconInfo): void;          // overwrite
  replaceRoster(entries: RosterEntry[]): void;      // callers only call on success
  getInfo(): BeaconInfo | null;
  getRoster(): RosterEntry[];
  getLocalAddress(): string;
}

export const SWARM_INFO_REFRESH_MS = 60_000;

export async function refreshSwarmInfo(store: SwarmInfoStore, baseUrl: string, logger: { warn: (m: string) => void }): Promise<void> {
  // GET `${baseUrl}/info` -> applyBeaconInfo (on ok)
  // GET `${baseUrl}/coordinator/beacons` -> if Array, replaceRoster(entries mapped from Beacon ⊕ BeaconView)
  // both wrapped in try/catch: failures keep the last known values (never regress roster to empty)
}

export function startSwarmInfoRefresh(store: SwarmInfoStore, baseUrl: string, logger: Logger): NodeJS.Timeout {
  const interval = setInterval(() => { void refreshSwarmInfo(store, baseUrl, logger); }, SWARM_INFO_REFRESH_MS);
  interval.unref();
  return interval;
}
```

- NEW `drone-agent/src/plugins/swarm/status-fragment.ts`:

```ts
export function createSwarmStatusFragment(store: SwarmInfoStore): DronePromptFragment {
  return {
    key: 'status',
    phase: 'header',
    render: async () => {
      const info = store.getInfo();
      const roster = store.getRoster();
      if (!info?.name && roster.length === 0) return false;
      const lines = ['# Swarm Status', ''];
      if (info?.name) lines.push(`- Local beacon: ${info.name} (${store.getLocalAddress()})`);
      if (info?.coordinatorHost) lines.push(`- Coordinator: ${info.coordinatorHost}${info.coordinatorPort ? `:${info.coordinatorPort}` : ''}`);
      if (roster.length > 0) {
        lines.push(`- Registered beacons (${roster.length}):`);
        for (const b of roster) {
          const markers: string[] = [];
          if (!b.connected) markers.push('offline');
          if (b.trustStatus && b.trustStatus !== 'approved') markers.push(b.trustStatus === 'rejected' ? 'rejected' : 'pending approval');
          lines.push(`  - ${b.name} (${b.host}:${b.port})${markers.length ? ` · ${markers.join(' · ')}` : ''}`);
        }
      }
      return lines.join('\n');
    },
  };
}
```

- NEW `drone-agent/src/plugins/swarm/identity-fragment.ts`:

```ts
export function createSwarmIdentityFragment(store: SwarmFragmentStore): DronePromptFragment {
  return { key: 'identity', phase: 'header', render: async () => store.renderIdentity() };
}
```

- EDIT `drone-agent/src/plugins/swarm/fragment-store.ts`:
  - Import `isReservedFragmentId` from `drone-swarm-common`.
  - `renderHeader()`/`renderFooter()` filter out reserved ids (`# Swarm Fragments` no longer shows identity).
  - Add to the `SwarmFragmentStore` interface:

```ts
renderIdentity(): string | false;
```

```ts
renderIdentity() {
  const reserved = Array.from(fragments.values()).filter(f => isReservedFragmentId(f.id));
  if (reserved.length === 0) return false;
  const sorted = [...reserved].sort((a, b) => a.id.localeCompare(b.id));
  return `# Swarm Identity\n\n${sorted.map(f => f.content).join('\n\n')}`;
}
```

  (Single reserved id today; a heading map keyed by id is the extension point if more are added.)

- EDIT `drone-agent/src/plugins/swarm/context.ts` — add `swarmInfo: SwarmInfoStore` to `SwarmContext` and construct it in `createSwarmContext(...)` (needs `localAddress`). Extend `createSwarmContext`'s signature with `localAddress: string`.
- EDIT `drone-agent/src/plugins/swarm/websocket.ts` — in the `connected` branch cache the pushed info, and refresh on open:

```ts
} else if (wsMsg.type === 'connected') {
  if (wsMsg.payload?.info) ctx.swarmInfo.applyBeaconInfo(wsMsg.payload.info);
  void refreshSwarmInfo(ctx.swarmInfo, ctx.baseUrl, registration.logger);
}
```

  and in `ctx.ws.onopen`: `void refreshSwarmInfo(ctx.swarmInfo, ctx.baseUrl, registration.logger);`
- EDIT `drone-agent/src/plugins/swarm/hooks.ts` — in `onPluginsLoaded`, alongside `reloadFromBeacon` / `connectWebSocket`: `void refreshSwarmInfo(ctx.swarmInfo, ctx.baseUrl, registration.logger);`
- EDIT `drone-agent/src/plugins/swarm/heartbeat.ts` — extend `registerShutdown` to clear the new interval.
- EDIT `drone-agent/src/plugins/swarm/index.ts`:
  - Pass `localAddress` (`${beaconHost}:${beaconPort}`) into `createSwarmContext`.
  - Register the three fragments in this order (before the existing footer fragment):

```ts
registration.registerPromptFragment(createSwarmStatusFragment(ctx.swarmInfo));
registration.registerPromptFragment(createSwarmIdentityFragment(ctx.fragmentStore));
registration.registerPromptFragment({ key: 'fragments.header', phase: 'header', render: () => Promise.resolve(ctx.fragmentStore.renderHeader()) });
registration.registerPromptFragment({ key: 'fragments.footer', phase: 'footer', render: () => Promise.resolve(ctx.fragmentStore.renderFooter()) });
```

  - Start the refresh interval next to `startHeartbeat(ctx)` and pass it to `registerShutdown`.

**Tests** (`drone-agent/test/`): `swarm-fragment-store` reserved-exclusion + `renderIdentity` (present/absent/multiple-reserved); `status-fragment` render (full data, no-coordinator, roster markers, `false` when empty, `false` before any fetch); `swarm-info` refresh (applies on success, keeps last-known on failure, never regresses roster to empty); `websocket` `connected` caching; `index` registration order (assert `renderPromptFragments()` order is `# Swarm Status` → `# Swarm Identity` → `# Swarm Fragments`).

**Dependency**: steps 1, 2, 3.

---

## Step 6 — Coordinator UI: Identity page — **coder**

**Files**
- EDIT `drone-coordinator-ui/src/lib/types.ts`:

```ts
export interface SwarmFragment {
  id: string; target: string; content: string;
  phase: 'header' | 'footer'; scope: 'local' | 'coordinator';
  createdAt: number; updatedAt: number; expiresAt: number | null;
}
```

- NEW `drone-coordinator-ui/src/lib/fragments.ts` — constants mirrored (drone-core is not importable from the web package; same convention as `lib/config-completions.ts`):

```ts
export const SWARM_IDENTITY_FRAGMENT_ID = 'swarm-identity';
export const BROADCAST_TARGET = 'broadcast';
export const MAX_FRAGMENT_CONTENT_BYTES = 16 * 1024;
```

- NEW `drone-coordinator-ui/src/pages/identity.tsx` — follows `config.tsx`'s patterns (`useAuthenticatedFetch`, `ErrorBanner`, `useToast`, `extractApiError`/`networkErrorMessage`, `Button`, `Skeleton`):
  - Load: `GET /api/fragments?target=broadcast` → `{ fragments }` → find `id === SWARM_IDENTITY_FRAGMENT_ID`; prefill a `<textarea>` with its `content`.
  - Save: `PUT /api/fragments/swarm-identity`, body `{ target: 'broadcast', content, phase: 'header' }`.
  - Clear: `DELETE /api/fragments/swarm-identity?target=broadcast` (with a confirm `Dialog`, `variant="destructive"`).
  - Character counter against `MAX_FRAGMENT_CONTENT_BYTES`; Save disabled when unchanged or empty; Clear disabled when no row exists.
  - Helper note: this text is injected into every agent's system prompt as a `# Swarm Identity` section.
- EDIT `drone-coordinator-ui/src/App.tsx` — `import IdentityPage from '@/pages/identity';`, add `{ to: '/identity', label: 'Identity', icon: '◆' }` to `navItems` (after Config), and `<Route path="/identity" element={<IdentityPage />} />`.

**Tests** (NEW `drone-coordinator-ui/src/pages/identity.test.tsx`, modeled on `config.test.tsx`): loads and prefills an existing row; empty state enables Save-disabled; Save issues the `PUT` with the right body; Clear issues the `DELETE` with `?target=broadcast`; API error surfaces via `ErrorBanner`; character counter.

**Dependency**: step 4 (routes must exist for the manual path; tests mock fetch).

---

## Step 7 — Documentation — **coder**

- EDIT `docs/agents/swarm-plugin.md` — add a "Swarm status fragment" section (source of each field, refresh cadence, render shape, hide-when-empty) and a "Swarm identity fragment" section (reserved id `swarm-identity`, broadcast + header, own budget, never expires, coordinator authoring routes, UI page), plus mention of the `fragmentsChanged` reverse-channel command and that coordinator fragment authoring is no longer read-only.
- EDIT `AGENTS.md` — extend the swarm-plugin bullet under `docs/agents/` (and the "Specialized Subsystems" list) to mention the two new fragments and the coordinator fragment-authoring routes.

**Dependency**: steps 2–6.

---

## Step 8 — Verification against the validation criteria — **reviewer/tester**

Walk the criteria below in order; do not declare done until every item passes.

---

## Validation criteria

1. **Build**: `pnpm -r run build` passes with zero errors. Because `drone-swarm-common` and `drone-core` are consumed from built `dist/`, run `pnpm -r run build` immediately after step 1 and again before relying on LSP/typecheck in dependents.
2. **Lint**: `pnpm -r run lint` passes with zero errors (eslint then prettier; re-read files after it runs).
3. **LSP**: zero diagnostics (errors *and* warnings) in every touched file, across `drone-swarm-common`, `drone-beacon`, `drone-coordinator`, `drone-agent`, `drone-coordinator-ui`.
4. **Fast tests**: `pnpm -r run test` passes, including all new tests in steps 1–6. Every new module/route/component has direct unit coverage; the reserved-fragment policy has explicit tests.
5. **Behavior — status fragment**: with a beacon and coordinator running, a fresh agent's system prompt contains `# Swarm Status` with the local beacon name + dialed address, the coordinator host:port (line absent when no coordinator is configured), and the registered-beacon roster; an offline or non-approved beacon shows the marker; the section is absent when neither info nor roster has ever loaded.
6. **Behavior — identity fragment**: `PUT /api/fragments/swarm-identity` from the UI page (or curl) causes the beacon's next sync to mirror the row and push `fragmentSync`; a connected agent then renders `# Swarm Identity` with the authored text, positioned after `# Swarm Status` and before `# Swarm Fragments`; the same row no longer renders under `# Swarm Fragments`; `DELETE` removes the section.
7. **Behavior — propagation**: with the identity edited while an agent is connected, the `fragmentsChanged` nudge makes the change land without waiting for the 5-minute sync (verify via `--debug swarm`/beacon logs).
8. **Budget policy**: writing 5 broadcast fragments does not block saving `swarm-identity`, and saving `swarm-identity` does not consume a user broadcast slot.
9. **No regressions**: existing fragment behavior (targeted fragments, TTL sweep, coordinator mirror, `fragmentSync`/`fragment` handling) is unchanged; the beacon's `POST /fragments` and `DELETE /fragments/:id` are behaviorally identical to before (aside from reserved-id handling).
10. **Optional (discretionary)**: `pnpm docker:smoke-test`, and a beacon↔coordinator integration test covering the write → nudge → mirror → agent-prompt path.
