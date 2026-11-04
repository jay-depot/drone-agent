---
key: plan-adr269-duration-hardening
tags:
  - plan
  - adr-269
  - drone-coordinator-ui
  - drone-coordinator
  - duration
  - ended-at
  - hardening
  - feat/ui-polish
status: completed
created: 2026-11-03T22:18:28.990Z
updated: 2026-11-03T22:29:24.590Z
---

# Plan: ADR 269 duration follow-ups — input guards, honest defaults, write-path invariant

Branch: feat/ui-polish (PR #153 open; verified 2026-11-03 — main tip is fc02fa6c/#151). Two commits: one UI, one coordinator. No new ADR; as-built wiki addendum after merge (D6).

## Why
ADR 269 (commit 6a58409b) added swarm_sessions.ended_at + a three-branch duration renderer. Branch review (memory: review-adr269-unknown-duration-finding) found four edges: (1) formatDuration trusts input — NaN prints "NaNd NaNh"; (2) an absent endedAt from a stale coordinator passes `!== null` and takes the frozen branch (same NaN output); (3) a missing status defaults to live (`?? 'active'`) and prints a growing age on a finished row; (4) updateSwarmSessionPersona and markStaleSessions rewrite rows without carrying ended_at.

## Locked decisions (operator-confirmed 2026-11-03)
- D1: formatDuration returns 'unknown' for non-finite input (NaN, Infinity). beacon-detail.tsx gets the fix free (same `durationMs !== null` stale-API hole); no change there.
- D2: formatSessionDuration normalizes `session.endedAt ?? null` once (operator picked ?? over !null loose equality and over !!truthiness, which would swallow 0); strict `!== null` stays. No loose equality anywhere.
- D3: live branch with non-finite age returns 'unknown', never '~unknown'.
- D4: SessionRow.status becomes required; `?? 'active'` removed. getStatusBadge's display fallback stays.
- D5: updateSwarmSessionPersona + markStaleSessions carry ended_at. Invariant: EVERY `UPDATE swarm_sessions` sets ended_at (greppable, 4 sites).
- D6: no new ADR; addendum to wiki page drone-coordinator-session-ended-at-duration-as-built after merge.

## Steps
1. (coder) drone-coordinator-ui/src/lib/duration.ts — first line of formatDuration: `if (!Number.isFinite(ms)) return 'unknown';`
2. (coder) same file — formatSessionDuration body: `const endedAt = session.endedAt ?? null; if (endedAt !== null) return formatDuration(endedAt - session.createdAt); const age = now - session.createdAt; if (LIVE_STATUSES.has(session.status) && Number.isFinite(age)) return `~${formatDuration(age)}`; return 'unknown';` Keep jsdoc, extend: absent endedAt behaves as null.
3. (coder) duration.test.ts +4: formatDuration(NaN)→'unknown'; formatDuration(Infinity)→'unknown'; `{createdAt:0, endedAt:undefined, status:'active'} as unknown as SessionDurationInput` with now=300_000 → '~5m' (cast is the point — JSON does not enforce types); same with status:'processing' → 'unknown'.
4. (coder) sessions.tsx: L193 `type SessionRow = BeaconSession & { status: string; endedAt: number | null };`; duration cell `status: session.status` (drop `?? 'active'`). Typecheck is the site-sweep: mapper always sets status, test helper sessionPayload already includes it. If a site is flagged, fix it; do not re-optionalize.
5. (coder) drone-coordinator/src/db/swarm-sessions.ts: updateSwarmSessionPersona UPDATE gains `ended_at = @endedAt`, run param `endedAt: existing.endedAt`; markStaleSessions loop UPDATE gains the same, param `endedAt: session.endedAt`.
6. (coder) db.test.ts +2: (a) stamp ended via updateSwarmSessionStatus, then updateSwarmSessionPersona('ss1','p2'), assert endedAt unchanged; (b) create session, manually UPDATE ended_at to a fixed value, markStaleSessions(1_000), assert value survived.
7. (reviewer/tester) Validation: LSP zero errors/warnings both packages; pnpm -r run build; pnpm typecheck; pnpm lint (prettier may reformat — re-read after); pnpm test fast suite green; 6 new tests green; grep: every `UPDATE swarm_sessions` in swarm-sessions.ts sets ended_at; grep: no `==`/`!=` loose equality added.
8. (coder) Commit on feat/ui-polish: A = steps 1-4 (UI), B = steps 5-6 (coordinator); include new .drone-agent/ memory files in commit B per AGENTS.md.

Dependencies: 1→2→3 (same file family); 4 same package, after 2; 5→6; 7 after all; 8 last. UI (1-4) and coordinator (5-6) are file-disjoint — two parallel workstreams.

Context: ADR 269 design record = wiki coordinator-swarm-sessions-ended-at-and-duration-column; as-built = wiki drone-coordinator-session-ended-at-duration-as-built; review findings = project memory review-adr269-unknown-duration-finding. LIVE_STATUSES = {'active','stale'} exists in both duration.ts and swarm-sessions.ts.

## Completed (2026-11-03) — executed by persona `code`

All 8 steps done on feat/ui-polish; every validation criterion passed.

- Commits: f5fa25fe (preliminary: plan + review memory files), a0c55c9f (UI, steps 1–4), and the coordinator commit that includes this memory file (steps 5–6; hash is circular with this file — see `git log -- drone-coordinator`).
- Steps 1–2 (duration.ts): formatDuration returns 'unknown' for non-finite input; formatSessionDuration normalizes `session.endedAt ?? null` once, keeps strict `!== null`, requires `Number.isFinite(age)` before the `~` live branch; jsdoc documents absent-endedAt-behaves-as-null.
- Step 3 (duration.test.ts): +4 tests — NaN→'unknown', Infinity→'unknown', absent endedAt + active → '~5m', absent endedAt + processing → 'unknown' (cast `as unknown as SessionDurationInput`). File now has 14 tests, all pass.
- Step 4 (sessions.tsx): SessionRow.status required, `?? 'active'` dropped. Typecheck found no other sites — the plan's mapper/test-helper assumption held.
- Step 5 (swarm-sessions.ts): updateSwarmSessionPersona and markStaleSessions now set `ended_at = @endedAt`, carrying the existing value. Invariant verified by grep: all 4 `UPDATE swarm_sessions` sites set ended_at.
- Step 6 (db.test.ts): +2 preservation tests — persona update preserves a stamped endedAt; markStaleSessions preserves a pre-set ended_at value (1_234_567).
- Step 7: LSP clean; `pnpm -r run build`, `pnpm typecheck`, `pnpm lint` pass (prettier reflowed long lines only); fast suite 4588 passed / 16 skipped / 0 failed; no loose equality added.
- D6 (wiki addendum to drone-coordinator-session-ended-at-duration-as-built) stays intentionally open until PR #153 merges, per the plan.