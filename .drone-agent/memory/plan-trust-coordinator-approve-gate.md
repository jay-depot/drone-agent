---
key: plan-trust-coordinator-approve-gate
tags:
  - plan
  - swarm
  - trust
  - coordinator-ui
  - beacon
created: 2026-09-24T05:49:23.451Z
updated: 2026-09-24T05:49:23.451Z
---

# Plan: Fix the `/trust-coordinator` approve gate (fingerprint confirmation never reaches the coordinator UI)

**Key:** `plan-trust-coordinator-approve-gate`
**Branch:** `fix/trust-coordinator-approve-gate` (created off `main`)

## Summary

After a user runs `/trust-coordinator <code>` and the code matches, the beacon confirms the coordinator's TLS fingerprint locally and announces it to the coordinator, which records it in `beacon_trust.fingerprint_confirmed_at`. But the coordinator UI's **Approve** button stays disabled forever, because the two endpoints the UI reads (`GET /beacons` and `GET /beacons/:id`) never include `fingerprintConfirmed`, while the UI gates the button on `beacon.fingerprintConfirmed === true`. This is an oversight from PR #105 (commit `04a8733`, "announce-gated beacon approval"); the UI's own tests mock the field, so they pass while the real API never supplies it.

We fix the root cause (one canonical beacon view that always carries `fingerprintConfirmed`) plus three contributing defects found in the same flow: the UI never learns of the change live, the WS `initial` snapshot can clobber the fetched list, and the beacon will not re-announce after a failed POST (so the recovery path — re-running the command — is a no-op).

## Background — the flow and the four defects

Trust flow: agent `/trust-coordinator <code>` -> beacon `POST /coordinator/trust` (`drone-beacon/src/routes/coordinator-trust.ts`) compares the code, calls `confirmCoordinatorFingerprint(fp)`, then announces via `getCoordinatorClient().confirmFingerprint()` -> coordinator `POST /api/beacons/trust/:id/confirm-fingerprint` (`drone-coordinator/src/routes/beacons.ts`) verifies the Ed25519 signature and calls `db.confirmBeaconFingerprint`.

| #           | Defect                                                                                                                                                                                                 | Evidence                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Primary** | `GET /beacons` and `GET /beacons/:id` omit `fingerprintConfirmed` (they map `trustStatus`, `publicKey`, `verificationCode` only). The UI gates on the missing field.                                   | `drone-coordinator/src/routes/beacons.ts` (~L128, ~L140); `drone-coordinator-ui/src/pages/topology.tsx` L268-269, `beacon-detail.tsx` L237, L247 |
| **A**       | Confirming publishes **no** WS event; the pages only re-fetch on mount and on `beacon.connected`/`disconnected`, so the button stays stale.                                                            | `routes/beacons.ts` confirm-fingerprint route (no `publishMutationEvent`)                                                                        |
| **B**       | WS `initial` is built from trust-less `listBeacons()` and can overwrite the fetched list (or vice-versa).                                                                                              | `drone-coordinator/src/index.ts` ~L447                                                                                                           |
| **C**       | The beacon announces only when `getPendingCoordinatorFingerprint()` is non-null; a successful local confirm clears pending, so a repeat command never re-announces. Self-heals only on beacon restart. | `drone-beacon/src/routes/coordinator-trust.ts` L49-62                                                                                            |

## Locked design decisions

1. **Scope:** all four defects.
2. **One beacon serializer (defect Primary + B):** a new `buildBeaconView(beaconId, trust)` returns `{ connected, trustStatus, publicKey, verificationCode, fingerprintConfirmed }` (`fingerprintConfirmed` a plain boolean) and is used by `GET /beacons`, `GET /beacons/:id`, **and** the WS `initial` builder. `connected: isBeaconConnected(...)` (3 sites) and the trust-field mapping (2 sites, one of which forgot the field) collapse into it.
3. **Live refresh (defect A):** the coordinator `confirm-fingerprint` route publishes a new WS event `beacon.fingerprintConfirmed` `{ beaconId }`. Both `topology.tsx` and `beacon-detail.tsx` subscribe to it **and** to the existing `beacon.approved`, and perform a **debounced (~100 ms) server-truth refetch** — mirroring the `sessions.tsx` lifecycle-event pattern (which deliberately ignores `initial`).
4. **Re-announce (defect C):** a gated helper `announceFingerprint({ force })` skips when `!isCoordinatorTrusted() || isBeaconApproved()`; otherwise it is throttled to one announce per 5 minutes unless `force`. Called from three places: the `/trust-coordinator` command (`force: true`), the existing 30 s pending approval-poll loop in `drone-beacon/src/index.ts` (throttled — no new timer), and the reverse-channel WS `open` handler in `coordinator-ws.ts` (throttled). **Stop condition = approved only** (`isBeaconApproved()`).

## Step-by-step implementation

> Conventions: `apply_diff` for edits; if it misbehaves, recall the `advanced-editing` skill. `file__write` may ignore "creates parents" — `mkdir -p` first for new dirs (none needed here). Do not run `pnpm -r run lint` until the code is final; prettier reformats, so re-read files before further edits.

### Step 1 — Coordinator: new `beacon-view.ts` (agent: coder)

**Depends on:** nothing. **File:** `drone-coordinator/src/beacon-view.ts` (new).

```ts
import type { BeaconTrustStatus } from './types.js';
import type { BeaconTrust } from './types.js';
import { isBeaconConnected } from './beacon-ws.js';

/**
 * Canonical beacon view shared by GET /beacons, GET /beacons/:id, and the
 * reverse-channel WS `initial` snapshot. The trust fields are derived from the
 * beacon_trust record so the shape is identical everywhere — a missing field
 * here previously left the UI's Approve gate disabled forever.
 */
export interface BeaconView {
  connected: boolean;
  trustStatus: BeaconTrustStatus | null;
  publicKey: string | null;
  verificationCode: string | null;
  fingerprintConfirmed: boolean;
}

export function buildBeaconView(
  beaconId: string,
  trust: BeaconTrust | undefined
): BeaconView {
  return {
    connected: isBeaconConnected(beaconId),
    trustStatus: trust?.status ?? null,
    publicKey: trust?.publicKey ?? null,
    verificationCode: trust?.verificationCode ?? null,
    fingerprintConfirmed: trust ? trust.fingerprintConfirmedAt !== null : false,
  };
}
```

### Step 2 — Coordinator: `routes/beacons.ts` uses the helper + publishes the event (agent: coder)

**Depends on:** Step 1.

- Add import: `import { buildBeaconView } from '../beacon-view.js';` (keep the existing `isBeaconConnected` import if still referenced elsewhere in the file, otherwise remove it — dead code rule).
- `GET /beacons`:

```ts
app.get('/beacons', async () => {
  const beacons = db.listBeacons();
  const trustList = db.listBeaconTrust();
  return beacons.map(b => {
    const trust = trustList.find(t => t.beaconId === b.id);
    return { ...b, ...buildBeaconView(b.id, trust) };
  });
});
```

- `GET /beacons/:id` (keep the beacon-or-trust fallback fields; drop the inline trust/connected mapping):

```ts
app.get<{ Params: { id: string } }>('/beacons/:id', async (request, reply) => {
  const beacon = db.getBeacon(request.params.id);
  const trust = db.getBeaconTrust(request.params.id);
  if (!beacon && !trust) {
    return reply.code(404).send({ error: 'Beacon not found' });
  }
  return {
    ...beacon,
    ...buildBeaconView(request.params.id, trust),
    beaconId: beacon?.id ?? trust?.beaconId,
    name: beacon?.name ?? trust?.name,
    host: beacon?.host ?? trust?.host,
    port: beacon?.port ?? trust?.port,
    connectedAt: beacon?.connectedAt,
    lastHeartbeat: beacon?.lastHeartbeat,
  };
});
```

- Confirm-fingerprint route, after `db.confirmBeaconFingerprint(request.params.id);`:

```ts
publishMutationEvent({
  sessionId: request.params.id,
  eventType: 'beacon.fingerprintConfirmed',
  payload: { beaconId: request.params.id },
});
return { success: true };
```

(`publishMutationEvent` is already imported.)

### Step 3 — Coordinator: WS `initial` builder uses the helper (agent: coder)

**Depends on:** Step 1. **File:** `drone-coordinator/src/index.ts` (~L447, inside the `/ws` handler).

Replace:

```ts
const beacons = listBeacons().map(b => ({
  ...b,
  connected: isBeaconConnected(b.id),
}));
```

with:

```ts
const beacons = listBeacons().map(b => ({
  ...b,
  ...buildBeaconView(b.id, getBeaconTrust(b.id)),
}));
```

Add imports: `buildBeaconView` from `./beacon-view.js`; `getBeaconTrust` from `./db/index.js`. Remove the now-unused `isBeaconConnected` import if nothing else in `index.ts` uses it.

### Step 4 — UI: debounced refetch on trust events (agent: coder)

**Depends on:** Step 2 (event must exist server-side). **Files:** `drone-coordinator-ui/src/pages/topology.tsx`, `drone-coordinator-ui/src/pages/beacon-detail.tsx`.

**topology.tsx** — lift the existing inline `fetchData` out of its effect into a `useCallback`, keep the mount effect, add a trust-event effect:

```ts
const fetchData = useCallback(async () => {
  setLoading(true);
  setError(null);
  try {
    const [beaconsRes, agentsRes] = await Promise.all([
      authFetch('/api/beacons'),
      authFetch('/api/agents/location'),
    ]);
    if (beaconsRes.ok) setBeacons(await beaconsRes.json());
    if (agentsRes.ok) setAgentLocations(await agentsRes.json());
  } catch {
    setError('Failed to load topology data');
  } finally {
    setLoading(false);
  }
}, [authFetch]);

useEffect(() => {
  fetchData();
}, [fetchData]);

useEffect(() => {
  const TRUST_EVENTS = new Set([
    'beacon.fingerprintConfirmed',
    'beacon.approved',
  ]);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const unsub = subscribe('event', msg => {
    const eventMsg = msg as WsEventMessage;
    if (!TRUST_EVENTS.has(eventMsg.eventType)) return;
    pending = true;
    if (debounceTimer === undefined) {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (pending) {
          pending = false;
          fetchData();
        }
      }, 100);
    }
  });
  return () => {
    unsub();
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  };
}, [subscribe, fetchData]);
```

Add `useCallback` to the React import if absent. Leave the existing `beacon.connected`/`beacon.disconnected` handler and the `initial` handler unchanged (defect B is fixed by making `initial` carry the same fields).

**beacon-detail.tsx** — analogous effect, refetching only this beacon, filtered by `beaconId`:

```ts
useEffect(() => {
  if (!id) return;
  const TRUST_EVENTS = new Set([
    'beacon.fingerprintConfirmed',
    'beacon.approved',
  ]);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const refetchBeacon = async () => {
    const res = await authFetch(`/api/beacons/${id}`);
    if (res.ok) setBeacon(await res.json());
  };

  const unsub = subscribe('event', msg => {
    const eventMsg = msg as WsEventMessage;
    if (!TRUST_EVENTS.has(eventMsg.eventType)) return;
    const payload =
      typeof eventMsg.payload === 'object' && eventMsg.payload !== null
        ? (eventMsg.payload as { beaconId?: string })
        : undefined;
    if (payload?.beaconId && payload.beaconId !== id) return;
    pending = true;
    if (debounceTimer === undefined) {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (pending) {
          pending = false;
          void refetchBeacon();
        }
      }, 100);
    }
  });

  return () => {
    unsub();
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  };
}, [id, subscribe, authFetch]);
```

### Step 5 — Beacon: new `fingerprint-announce.ts` (agent: coder)

**Depends on:** nothing. **File:** `drone-beacon/src/fingerprint-announce.ts` (new).

```ts
import { logger } from './logger.js';
import { isBeaconApproved, isCoordinatorTrusted } from './coordinator-trust.js';
import { getCoordinatorClient } from './routes/context.js';

const REANNOUNCE_INTERVAL_MS = 5 * 60 * 1000;

let lastAnnounceAt = 0;

/**
 * Announce the coordinator-fingerprint confirmation to the coordinator so its
 * approve gate unlocks. The coordinator side is idempotent. Skips when the
 * coordinator fingerprint is not trusted or the beacon is already approved;
 * otherwise throttled to one announce per REANNOUNCE_INTERVAL_MS unless
 * `force` (the explicit /trust-coordinator command bypasses the throttle).
 */
export function announceFingerprint(opts: { force?: boolean } = {}): void {
  if (!isCoordinatorTrusted() || isBeaconApproved()) {
    return;
  }
  const now = Date.now();
  if (!opts.force && now - lastAnnounceAt < REANNOUNCE_INTERVAL_MS) {
    return;
  }
  lastAnnounceAt = now;
  getCoordinatorClient()
    ?.confirmFingerprint()
    .catch(err =>
      logger.warn(`Failed to announce fingerprint confirmation: ${err}`)
    );
}

/** Test-only: reset the throttle. */
export function resetFingerprintAnnounce(): void {
  lastAnnounceAt = 0;
}
```

### Step 6 — Beacon: wire the three call sites (agent: coder)

**Depends on:** Step 5.

(1) `drone-beacon/src/routes/coordinator-trust.ts` — replace the gated inline announce:

```ts
const fp = getPendingCoordinatorFingerprint();
if (fp) {
  confirmCoordinatorFingerprint(fp);
}
announceFingerprint({ force: true });
return { success: true };
```

Add `import { announceFingerprint } from '../fingerprint-announce.js';`. Remove the now-unused `getCoordinatorClient` (`./context.js`) and `logger` (`../logger.js`) imports if nothing else in the file references them.

(2) `drone-beacon/src/index.ts` — the pending approval-poll loop (~L430). At the top of the `pollInterval` callback add `announceFingerprint();`. Add the import.

(3) `drone-beacon/src/coordinator-ws.ts` — in `ws.on('open', ...)` add `announceFingerprint();`. Add `import { announceFingerprint } from './fingerprint-announce.js';`.

### Step 7 — Tests (agent: tester)

**Depends on:** Steps 1–6.

- Coordinator, new `drone-coordinator/test/beacon-view.test.ts`: `buildBeaconView` returns `fingerprintConfirmed: false` for no trust / null `fingerprintConfirmedAt`, `true` when set; field mapping; `connected` reflects `isBeaconConnected`.
- Coordinator, `test/routes/beacons.test.ts`: assert `fingerprintConfirmed` false before / true after a confirm-fingerprint announce on both `GET /beacons` and `GET /beacons/:id`; assert confirm-fingerprint publishes `beacon.fingerprintConfirmed`.
- Coordinator WS initial: assert the `initial` payload's beacons carry `trustStatus`/`verificationCode`/`fingerprintConfirmed`.
- Beacon, new `drone-beacon/test/fingerprint-announce.test.ts`: skips when `!isCoordinatorTrusted()`; skips when `isBeaconApproved()`; calls `client.confirmFingerprint` when trusted+unapproved; throttles a second non-forced call within 5 min; `force` bypasses the throttle; use `resetFingerprintAnnounce()` between cases.
- Beacon, `test/routes.test.ts`: `POST /coordinator/trust` announces even when there is no pending fingerprint (already trusted) — the repeat-command recovery path.
- UI, `topology.test.tsx`: a `beacon.fingerprintConfirmed` event causes a second `/api/beacons` fetch; likewise `beacon.approved`.
- UI, `beacon-detail.test.tsx`: a `beacon.fingerprintConfirmed` event for this beacon re-fetches `/api/beacons/:id`; an event for a different `beaconId` does not.

### Step 8 — Final validation against the criteria below (agent: reviewer)

## Files touched

**Coordinator:** `src/beacon-view.ts` (new), `src/routes/beacons.ts`, `src/index.ts`, `test/beacon-view.test.ts` (new), `test/routes/beacons.test.ts`, plus the WS-initial test.
**Beacon:** `src/fingerprint-announce.ts` (new), `src/routes/coordinator-trust.ts`, `src/index.ts`, `src/coordinator-ws.ts`, `test/fingerprint-announce.test.ts` (new), `test/routes.test.ts`.
**UI:** `src/pages/topology.tsx`, `src/pages/beacon-detail.tsx`, `src/pages/topology.test.tsx`, `src/pages/beacon-detail.test.tsx`.
**No `drone-core` / `drone-swarm-common` changes** -> no cross-package rebuild required before typecheck.

## Validation criteria (final section)

1. **LSP clean** on every touched file (connected `typescript` server), zero errors/warnings. If editing `drone-core`/`drone-swarm-common`, run `pnpm -r run build` first — not expected here.
2. **`pnpm -r run lint` passes** (ESLint + Prettier) with zero errors — the project's linting process. Re-read files after, since Prettier reformats.
3. **`pnpm -r run build` passes** with zero errors.
4. **`pnpm -r run test` (fast suite) passes**, including all new tests above.
5. **Reproduction closed:** a coordinator test proves `GET /beacons` and `GET /beacons/:id` return `fingerprintConfirmed: true` after a confirmed announce (fails pre-fix, passes post-fix), and a UI test proves a `beacon.fingerprintConfirmed` event refetches the beacon list.
6. **No dead code / unused vars** (removed imports where they became unused); no fluff comments; new code unit-tested.
7. **Manual smoke (recommended):** with a live beacon+coordinator, run `/trust-coordinator <code>` and confirm the UI Approve button enables without a manual reload; then approve and confirm the row updates live. Optional: verify a repeat `/trust-coordinator` re-announces after a simulated failed POST.
8. **Commit on the feature branch.** Per `AGENTS.md`, on a named feature branch check in the code **and** the new project-memory plan together (do not commit to `main`).

## Out of scope / follow-ups (log as insights, do not implement here)

- `GET /beacons/:id` also omits `tlsFingerprint`, which `beacon-detail.tsx` tries to render — same-class latent bug, outside the agreed four. Optional: fold into `buildBeaconView` later.
- Unrelated slash-command quirks (e.g. `--now` rest-of-line handling) are untouched.

---

## ✅ COMPLETED 2026-09-24 (branch `fix/trust-coordinator-approve-gate`)

All 8 steps executed. Commits: `406e69b0` (feature) on top of `b0055684` (repo-wide prettier pass, committed per user request; pure formatting — lockfile has zero non-format content lines, safe under CI `pnpm install --frozen-lockfile`).

### What landed

- **Step 1/3:** new `drone-coordinator/src/beacon-view.ts` — `buildBeaconView(beaconId, trust)` (returns `{connected, trustStatus, publicKey, verificationCode, fingerprintConfirmed}`) plus `buildInitialBeaconList()` (the WS `initial` snapshot). `GET /beacons`, `GET /beacons/:id`, and `index.ts`'s WS `initial` builder all use it — the field can no longer be forgotten per-site, and the `initial` snapshot no longer clobbers the fetched list. `isBeaconConnected` imports removed from `routes/beacons.ts` and `index.ts` (now unused).
- **Step 2:** confirm-fingerprint route publishes `beacon.fingerprintConfirmed` `{beaconId}`.
- **Step 4:** `topology.tsx` (lifted `fetchData` into a `useCallback`) and `beacon-detail.tsx` (per-beacon refetch) both debounce-refetch (~100 ms) on `beacon.fingerprintConfirmed` and `beacon.approved`, mirroring `sessions.tsx`.
- **Step 5/6:** new `drone-beacon/src/fingerprint-announce.ts` — `announceFingerprint({force})` (skip unless trusted-and-unapproved; 5-min throttle unless forced; `resetFingerprintAnnounce()` test hook). Wired to the `/trust-coordinator` command (`force:true`), the 30 s pending poll loop (throttled), and the reverse-channel WS `open` handler (throttled). The route's old inline gated announce + its now-unused `getCoordinatorClient`/`logger` imports were removed.
- **Step 7:** tests — `drone-coordinator/test/beacon-view.test.ts` (new), `drone-coordinator/test/routes/beacons.test.ts` (+3: fingerprintConfirmed false→true on both GETs, publish assertion), `drone-beacon/test/fingerprint-announce.test.ts` (new), `drone-beacon/test/routes.test.ts` (+1 repeat-command recovery), `drone-coordinator-ui/src/pages/topology.test.tsx` (+2), `beacon-detail.test.tsx` (+2).
- Plan memory (this file) committed with the feature.

### Validation (Step 8)

- LSP: clean on all touched files (no errors/warnings).
- **`pnpm -r run lint` does NOT exist** in this repo (no package has a `lint` script). The project's lint process is the root **`pnpm lint`** (= `eslint . --fix` + `prettier --write .`). Ran that → exit 0. Noted as an AGENTS.md/plan discrepancy (code is source of truth).
- `pnpm -r run build` → exit 0 (all 8 projects).
- `pnpm -r run test` (fast): drone-core 152, drone-coordinator-ui 317, drone-gateway 160, drone-swarm-common 107 all pass; drone-coordinator **450 pass / 1 fail** — the single failure is `test/wiki-routes.test.ts > GET /api/wiki/graph returns nodes and edges from the coordinator store`, which was **verified pre-existing** by stashing the whole change set and reproducing the identical failure on the clean tree (+ confirmed independent of a stray `knowledge-base/` artifact). Not a regression.
- Reproduction closed: the new coordinator tests fail pre-fix (field absent → `undefined`) and pass post-fix; the UI tests prove the event-driven refetch. The `drone-coordinator-ui` tests require `NODE_ENV=test` (baked into that package's `test` script) — running vitest without it yields `React.act is not a function` across the whole suite (environment, not code).

### Notes / follow-ups

- `GET /beacons/:id` still omits `tlsFingerprint` (which `beacon-detail.tsx` renders) — same class as the fixed bug, left out of the agreed scope; the shared `buildBeaconView` makes folding it in a one-line change later.
- Manual smoke (live beacon+coordinator) not run from this session; the plan recommends it pre-release.
- Stray artifacts cleaned before commit: test-generated `drone-beacon/knowledge-base/` and `drone-coordinator/knowledge-base/` (created by the wiki-route tests) and non-task prettier churn confined to the dedicated prettier commit.
