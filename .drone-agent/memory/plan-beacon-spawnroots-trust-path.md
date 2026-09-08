---
key: plan-beacon-spawnroots-trust-path
tags:
  []
created: 2026-09-08T23:17:03.506Z
updated: 2026-09-08T23:17:03.506Z
---

# Plan: Beacon spawnRoots lost on trust-path registration (fix + merge-on-omit)

## Summary
The coordinator UI "New Session" panel shows "No roots advertised" even when the beacon's `spawnRoots` config is valid. Root cause: the coordinator's `POST /api/beacons` route drops `spawnRoots`/`defaultSpawnRoot` when the body carries a `publicKey` (the trust path — the branch every real beacon takes via `registerBeacon` in `drone-beacon/src/coordinator-client.ts`). `db.registerBeacon` (INSERT OR REPLACE) then writes NULL roots on every registration, including the periodic re-scan re-advertise. The beacon side is correct; this is purely a coordinator bug.

## Decision (user-picked option B)
1. Pass roots through the trust path.
2. Merge-on-omit semantics in `db.registerBeacon`: absent (undefined) roots fields preserve the existing row's values; present fields (including explicit `[]` / `''`) overwrite. Rationale: the coordinator is a passive cache of beacon-pushed state (ADR 43 style); a partial re-registration must not erase a working advertisement. The beacon always sends both fields, so explicit clearing remains possible.

## Non-goals
- No beacon changes (config load, glob expansion, advertise body all verified correct).
- No required UI changes (one optional UX step below).

## Steps (order = execution order)

1. **[tester]** Write the failing regression test first (fail-first discipline):
   - `drone-coordinator/test/routes/beacons.test.ts` — new test: `POST /api/beacons` with `publicKey` + `tlsFingerprint` + `spawnRoots: ['/home/user/']` + `defaultSpawnRoot: '/home/user/'`, then `GET /api/beacons` expects `b1.spawnRoots` toEqual `['/home/user/']` and `defaultSpawnRoot` toBe `'/home/user/'`. Run it; it MUST fail (this reproduces the bug).
2. **[coder]** Trust branch passes roots through — `drone-coordinator/src/routes/beacons.ts` (~line 47):
   ```ts
   db.registerBeacon({
     id: request.body.id,
     name: request.body.name,
     host: request.body.host,
     port: request.body.port,
     spawnRoots: request.body.spawnRoots,
     defaultSpawnRoot: request.body.defaultSpawnRoot,
   });
   ```
   (`request.body` is typed `RegisterBeaconRequest`, which already has both fields; `RegisterBeaconTrustRequest` needs no change.)
3. **[coder]** Merge-on-omit in `db.registerBeacon` — `drone-coordinator/src/db/beacons.ts`:
   ```ts
   export function registerBeacon(req: RegisterBeaconRequest): Beacon {
     const now = Date.now();
     const existing = getBeacon(req.id);
     const beacon: Beacon = {
       id: req.id, name: req.name, host: req.host, port: req.port,
       connectedAt: now, lastHeartbeat: now,
       spawnRoots: req.spawnRoots ?? existing?.spawnRoots,
       defaultSpawnRoot: req.defaultSpawnRoot ?? existing?.defaultSpawnRoot,
     };
     // ... existing INSERT OR REPLACE unchanged
   ```
   Note: `existing?.spawnRoots` may be undefined on conflict-with-NULL — that is correct (nothing to preserve). better-sqlite3 named bindings tolerate extra/undefined keys here, matching current behavior. (Alternative considered and rejected: single-statement UPSERT with `COALESCE(excluded.x, x)` — more elegant but rewrites SQL semantics for all callers for no behavioral gain.)
4. **[tester]** Add remaining tests:
   - `drone-coordinator/test/db.test.ts` (Beacon CRUD): (a) register with roots, re-register WITHOUT roots → preserved; (b) register with roots, re-register with NEW roots → replaced; (c) fresh registration without roots → `spawnRoots` undefined.
   - `drone-coordinator/test/routes/beacons.test.ts`: route-level (a) trust-path re-registration without roots preserves roots; (b) trust-path re-registration with new roots replaces them.
   - Step 1's test now passes.
5. **[reviewer]** Cross-cutting sweep (shared-interface discipline): LSP find-references on `db.registerBeacon` (expected: `db/index.ts` re-export, both route branches, db tests) + grep `spawnRoots`/`defaultSpawnRoot` across packages to catch any stale mock or overlooked dispatch. Known callers only; no other package touches these fields.
6. **[coder, OPTIONAL — strike if unwanted]** UX nicety in `drone-coordinator-ui/src/pages/sessions.tsx` New Session panel: when beacon selection changes, preselect `workingDir` from that beacon's `defaultSpawnRoot` (requires the UI Beacon type to carry `defaultSpawnRoot`; check the local type def). Skip if scope must stay minimal.
7. **[coder]** Docs (project wiki lives in /home/unleet/Obsidian/drone-agent-project/):
   - New `decisions/200-beacon-spawnroots-trust-path.md` — ADR: trust-path drop bug + merge-on-omit decision (per meta/decision-bug-fixes-go-in-decisions convention).
   - Add ADR 200 row to `decisions/index.md` (and bump "Latest" pointer); add one-line cross-link note in `decisions/197-beacon-cwd-roots.md` ("roots dropped on trust path; fixed in ADR 200"); update the `modules/drone-coordinator` row in `index.md`.
8. **[reviewer]** Final validation check (criteria below) before declaring done.

## Validation criteria (MUST all pass)
- Step 1 regression test fails on unfixed code and passes after (fail-first evidence noted).
- LSP diagnostics clean across the workspace (no exceptions for tests).
- `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm -r run test` all pass with zero errors.
- No new `any`, no eslint-disable, no dead code; comments follow project comment rules.
- Optional manual smoke: run beacon with `spawnRoots` config against coordinator → `GET /api/beacons` shows roots → UI launch panel lists them and spawn succeeds.

## Context for the executing agent
- Search "No roots advertised" → `drone-coordinator-ui/src/pages/sessions.tsx:160` (the symptom).
- The bug: `drone-coordinator/src/routes/beacons.ts` trust branch (~line 47) called `db.registerBeacon({ id, name, host, port })`, discarding the roots fields from the body.
- Existing test gap: `drone-coordinator/test/routes/beacons.test.ts:191` only exercises the legacy (no-`publicKey`) branch.