---
tags: [decision, swarm, trust, coordinator-ui, beacon]
related:
  [
    decisions/211-beacon-coordinator-trust-hardening.md,
    decisions/191-topology-live-ws-status.md,
    concepts/beacon-verification.md,
    concepts/mtls-and-reverse-channel.md,
    modules/drone-coordinator.md,
    modules/drone-beacon.md,
    modules/drone-coordinator-ui.md,
  ]
---

# 220 — `/trust-coordinator` approve gate: deliver `fingerprintConfirmed` to the UI + live trust refresh

**Summary**: After `/trust-coordinator <code>` matched, the beacon confirmed the coordinator fingerprint and announced it, and the coordinator recorded it — yet the UI **Approve** button stayed disabled forever. Root cause: the two endpoints the UI reads (`GET /beacons`, `GET /beacons/:id`) never included `fingerprintConfirmed` while the UI gated on it — an oversight from [211-beacon-coordinator-trust-hardening](211-beacon-coordinator-trust-hardening.md) (PR #105) whose UI tests mock the field, so the suite stayed green. Fix: one canonical `buildBeaconView` serializer used by all three beacon-view sites, a `beacon.fingerprintConfirmed` live event with debounced server-truth refetch, and a gated beacon-side re-announce so a repeat command recovers a failed announce.

## Context

The trust handshake ([211-beacon-coordinator-trust-hardening](211-beacon-coordinator-trust-hardening.md)) gates beacon approval on the beacon having confirmed the coordinator's TLS fingerprint:

1. agent `/trust-coordinator <code>` → beacon `POST /coordinator/trust` (compares the transcribed code against its in-memory copy), calls `confirmCoordinatorFingerprint(fp)`, then announces via `CoordinatorClient.confirmFingerprint()`.
2. coordinator `POST /api/beacons/trust/:id/confirm-fingerprint` verifies an Ed25519 signature and calls `db.confirmBeaconFingerprint` → sets `beacon_trust.fingerprint_confirmed_at`.
3. `POST /api/beacons/trust/:id/approve` is guarded by `fingerprint_confirmed_at IS NOT NULL` (409 otherwise).

The UI gates its Approve button on `beacon.fingerprintConfirmed === true`. But the coordinator only shipped that field on the **poll** endpoint `GET /beacons/trust/:id` — which the UI never calls. The list/detail endpoints the UI does call mapped `trustStatus`/`publicKey`/`verificationCode` but not `fingerprintConfirmed`, so the field was always `undefined` on the client and the gate was permanently closed.

## Decision

Fix the root cause (one serializer that always carries the field) plus three contributing defects found in the same flow.

### 1. One canonical beacon view (root cause + initial-clobber)

New `drone-coordinator/src/beacon-view.ts`:

- `buildBeaconView(beaconId, trust)` → `{ connected, trustStatus, publicKey, verificationCode, fingerprintConfirmed }` (`fingerprintConfirmed` a plain boolean, derived from `trust.fingerprintConfirmedAt !== null`).
- `buildInitialBeaconList()` — the WS `initial` snapshot composition.

`GET /beacons`, `GET /beacons/:id`, **and** the `/ws` `initial` builder in `index.ts` all consume it. Collapsing the three sites (which had drifted) means `connected: isBeaconConnected(...)` and the trust-field mapping exist once, so a field can no longer be forgotten per-site — and the WS `initial` snapshot (previously trust-less, and able to clobber the fetched list on the `/api/beacons` race) now carries the same shape as the fetch.

### 2. Live refresh (new event + debounced server-truth refetch)

The coordinator `confirm-fingerprint` route publishes a new WS event `beacon.fingerprintConfirmed` `{ beaconId }`. Both `topology.tsx` and `beacon-detail.tsx` subscribe to it **and** to the existing `beacon.approved`, and perform a ~100 ms-debounced **server-truth refetch** (topology refetches `/api/beacons`; detail refetches `/api/beacons/:id`, filtered by `beaconId`). This mirrors the `sessions.tsx` lifecycle-event pattern (the page ignores the `initial` snapshot) and means the operator sees Approve enable **without a manual reload** — the field fix alone would have looked broken because the page was stale.

### 3. Beacon-side re-announce (recovery path works again)

`announceFingerprint({ force })` (new `drone-beacon/src/fingerprint-announce.ts`):

- skips when `!isCoordinatorTrusted() || isBeaconApproved()` (stop condition = **approved only**);
- otherwise throttled to one announce per **5 minutes** unless `force`.

Previously the route announced only when `getPendingCoordinatorFingerprint()` was non-null; a successful local confirm clears pending, so a repeat `/trust-coordinator` with the correct code was a no-op — a failed announce self-healed only at beacon restart. Now three call sites converge on the same idempotent gate:

1. `POST /coordinator/trust` — `force: true` (explicit command retries immediately);
2. the existing 30 s pending approval-poll loop in `index.ts` — throttled, no new timer;
3. the reverse-channel WS `open` handler in `coordinator-ws.ts` — throttled, covering wake-from-sleep reconnects.

## Consequences

- The UI's Approve affordance now reflects server truth on first load **and** live.
- A repeat `/trust-coordinator` recovers a dropped announce within seconds; the periodic paths bound the worst case to ~5 minutes; beacon restart remains the final self-heal.
- `GET /beacons/:id` still omits `tlsFingerprint` (which `beacon-detail.tsx` renders) — a same-class latent bug left out of this change's agreed scope; the shared `buildBeaconView` makes folding it in a one-line change later.
- The coordinator's `confirm-fingerprint` route is idempotent, so the extra throttled announces are harmless duplicate writes.

## Validation

- LSP clean on all touched files; `pnpm -r run build` exit 0.
- `pnpm -r run test` (fast): drone-core 152, drone-coordinator-ui 317, drone-gateway 160, drone-swarm-common 107 all pass; drone-coordinator 450 pass / 1 fail — the single failure (`test/wiki-routes.test.ts > GET /api/wiki/graph…`) is **pre-existing** (reproduced identically on a stashed clean tree).
- Reproduction closed: new coordinator tests prove `fingerprintConfirmed` is `false` before and `true` after a confirmed announce on both `GET /beacons` and `GET /beacons/:id`, and that `confirm-fingerprint` publishes `beacon.fingerprintConfirmed`; UI tests prove the event-driven refetch.
- Note: `pnpm -r run lint` does not exist in this repo (no package declares a `lint` script); the project lint entrypoint is the **root** `pnpm lint` (`eslint --fix` + `prettier --write .`), which passes. Running it reformats the whole repo, so the prettier churn was committed separately (see decision-bug-fixes-go-in-decisions note below).

## Related

- [211-beacon-coordinator-trust-hardening](211-beacon-coordinator-trust-hardening.md) — the announce-gated approval this completes (the missing-field oversight)
- [191-topology-live-ws-status](191-topology-live-ws-status.md) — the same server-truth-vs-heartbeat lesson for beacon status
- beacon-verification — the bidirectional verification-code handshake
- [drone-coordinator](../../drone-coordinator/) — `beacon-view.ts`, `routes/beacons.ts`, `index.ts`
- [drone-beacon](../../drone-beacon/) — `fingerprint-announce.ts` + the three call sites
- [drone-coordinator-ui](../../drone-coordinator-ui/) — topology + beacon-detail live refresh
