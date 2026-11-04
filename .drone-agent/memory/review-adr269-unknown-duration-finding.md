---
key: review-adr269-unknown-duration-finding
tags:
  - review
  - adr-269
  - duration
  - ended-at
  - good-practice
  - followup
created: 2026-11-03T22:03:12.870Z
updated: 2026-11-03T22:29:00.000Z
---

Review of ADR 269 branch (feat/ui-polish, commit 6a58409b), 2026-11-03. The legacy-archived-row path is CORRECT: migration leaves ended_at NULL, no write path stamps an already-non-live row (set-once guard tests the FROM-status), so a legacy archived row renders 'unknown' when both coordinator and UI builds are current. If 'unknown' does not show in a live deployment, suspect: (1) coordinator process not restarted after build — API omits endedAt, renderer's strict `endedAt !== null` passes for undefined, falls into the frozen branch and prints "NaNd NaNh"; (2) stale UI bundle; (3) rows were live at deploy time and ended after — they carry a real stamp by design (D2), frozen value is correct. Code follow-ups: formatDuration should guard non-finite input (NaN today renders "NaNd NaNh"); formatSessionDuration should use a loose null check or the formatter guard; `session.status ?? 'active'` in sessions.tsx defaults a missing status to LIVE, which is the dishonest default. Good practice observed and worth keeping: the FROM-live set-once stamp (test: 'a legacy non-live row keeps endedAt null') and making endedAt a required field, which caught the transcript.test.ts construction site at compile time.

LANDED 2026-11-03: all three code follow-ups fixed per plan-adr269-duration-hardening (commits a0c55c9f + the coordinator commit on feat/ui-polish): formatDuration now returns 'unknown' for non-finite input, formatSessionDuration normalizes absent endedAt with `?? null` (operator rejected loose equality), `?? 'active'` is gone, and updateSwarmSessionPersona/markStaleSessions carry ended_at.
