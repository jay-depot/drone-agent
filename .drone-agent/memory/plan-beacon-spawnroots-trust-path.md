---
key: plan-beacon-spawnroots-trust-path
tags:
  []
created: 2026-09-08T23:17:03.506Z
updated: 2026-09-08T23:22:07.849Z
---

# Plan: Beacon spawnRoots lost on trust-path registration (fix + merge-on-omit)

## Summary
The coordinator UI "New Session" panel shows "No roots advertised" even when the beacon's `spawnRoots` config is valid. Root cause: the coordinator's `POST /api/beacons` route drops `spawnRoots`/`defaultSpawnRoot` when the body carries a `publicKey` (the trust path — the branch every real beacon takes via `registerBeacon` in `drone-beacon/src/coordinator-client.ts`). `db.registerBeacon` (INSERT OR REPLACE) then writes NULL roots on every registration, including the periodic re-scan re-advertise. The beacon side is correct; this is purely a coordinator bug.

## Decision (user-picked option B)
1. Pass roots through the trust path.
2. Merge-on-omit semantics in `db.registerBeacon`: absent (undefined) roots fields preserve the existing row's values; present fields (including explicit `[]` / `''`) overwrite. Rationale: the coordinator is a passive cache of beacon-pushed state (ADR 43 style); a partial re-registration must not erase a working advertisement. The beacon always sends both fields, so explicit clearing remains possible.

## Steps (order = execution order)
1. **[tester]** Failing trust-path regression test (fail-first).
2. **[coder]** Trust branch passes roots through (`routes/beacons.ts`).
3. **[coder]** Merge-on-omit in `db.registerBeacon` (`db/beacons.ts`).
4. **[tester]** db + route merge tests (preserve/replace/fresh-undefined).
5. **[reviewer]** Cross-cutting sweep (find-references + grep).
6. **[coder, OPTIONAL]** UI preselect workingDir from defaultSpawnRoot.
7. **[coder]** Docs — ADR 200, index updates, cross-link in ADR 197.
8. **[reviewer]** Final validation (LSP, build, typecheck, lint, tests).

## Execution Summary (2026-09-08) — STATUS: COMPLETE

All steps executed. Step 6 turned out to be ALREADY IMPLEMENTED before execution: `drone-coordinator-ui/src/pages/sessions.tsx` (line ~78) already re-seeds `workingDir` from `selectedBeacon?.defaultSpawnRoot ?? spawnRoots[0]` on beacon change, and `drone-coordinator-ui/src/lib/types.ts` already carried `defaultSpawnRoot` — verified, no change needed.

Changes landed:
- `drone-coordinator/src/routes/beacons.ts` — trust branch forwards `spawnRoots`/`defaultSpawnRoot` to `db.registerBeacon`.
- `drone-coordinator/src/db/beacons.ts` — `registerBeacon` reads the existing row and applies merge-on-omit for both roots fields; INSERT OR REPLACE statement unchanged.
- `drone-coordinator/test/routes/beacons.test.ts` — +3 tests: trust-path registration returns roots (the regression test; DEMONSTRATED FAILING pre-fix: `expected undefined to deeply equal ['/home/user/']`), trust-path re-registration without roots preserves, with new roots replaces.
- `drone-coordinator/test/db.test.ts` — +3 tests: db-level merge-on-omit preserve / replace / fresh-undefined.
- Docs: `decisions/200-beacon-spawnroots-trust-path.md` (new), row added to `decisions/index.md` (top), cross-link bullet in `decisions/197-beacon-cwd-roots.md` Related section, `modules/drone-coordinator` row updated in `index.md`.

Validation results (all green):
- LSP: zero errors/warnings workspace-wide (only pre-existing hints in untouched files).
- `pnpm -r run build` ✓, `pnpm typecheck` ✓, `pnpm lint` ✓ (prettier: all files unchanged).
- Fast suite via root `pnpm test`: 2858 passed / 14 skipped, zero failures. NOTE: do NOT use `pnpm -r run test` — it misfires on drone-core (no test files; the workspace vitest config is root-based and includes all packages).
- Manual smoke not run (no live beacon/coordinator on this host); covered by route-level integration tests via `app.inject`.

Commits: plan c5f267a; execution commit follows this memory update on `feat/coordinator-ui-sessions`.