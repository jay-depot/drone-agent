---
key: insight-lastExamined-tracking-plan
tags:
  []
created: 2026-08-11T00:37:00.632Z
updated: 2026-08-11T00:46:52.125Z
---

# Plan: Insight lastExamined Tracking for the Promotion Process

## Summary
Add an optional/nullable `lastExamined` timestamp to all insight entries (local file-based + swarm SQLite), plus a hidden-by-default tool that the insights→principles promotion process (e.g. reflect persona) premounts to mark a target's insights as examined "as of now."

## Design decisions
1. Separate hidden tool `self-improvement__mark_examined`, `defaultHidden: true`, premounted only by the promotion persona (not added as an action on the existing insight tool).
2. "Mark all in target as of now" — sets `lastExamined` on every entry of the given target.
3. Server-side timestamp for swarm — beacon/coordinator compute `now`; no caller-passed timestamp.
4. Overwrite-all — re-marking bumps `lastExamined = now` on all entries (new insights after a mark have no lastExamined = unexamined).

## Steps (ALL COMPLETED)
1. drone-core capabilities.ts: lastExamined on DroneInsightEntry + markInsightsExamined on DroneInsightStorageEngine. Done.
2. file-engine.ts: markInsightsExamined under withFileLock, sets lastExamined on all, atomic write, skip write when empty (fix for empty-target ENOENT). Done.
3. swarm beacon+coordinator: idempotent PRAGMA table_info + ALTER TABLE migration in init.ts (also in CREATE TABLE), lastExamined on InsightRow + markInsightsExamined() SQL UPDATE, POST /insights/mark-examined route (coordinator direct; beacon proxies scope=coordinator), db/index.ts export. Done.
4. swarm/hooks.ts: lastExamined passthrough on readInsights/listInsights; markInsightsExamined HTTP POST. Done.
5. New tool tools/mark-examined.ts (defaultHidden, validateTarget, resolveInsightEngine) + register in index.ts. Done.
6. Promotion persona (reflect): fixed `automountTools` -> `premountedTools` (the automountTools key was unsupported and silently ignored - a typo in the user's file); added mark_examined under self-improvement. Persona is at ~/.drone-agent/personas/reflect/persona.md (user-scoped, outside repo). Done.
7. Tests: mark-examined.test.ts (set, empty->0, overwrite, new-insight-unexamined, defaultHidden absent until premount, recall surfaces lastExamined); beacon + coordinator db.test.ts markInsightsExamined CRUD; beacon + coordinator route tests for POST /insights/mark-examined incl 400. Done.
8. Validation: build/typecheck/lint pass, 1787 tests pass (9 pre-existing skips), LSP clean (only pre-existing hints in swarm/hooks.ts), grep sweep confirms both engines have markInsightsExamined. Done.

## Notes / gotchas
- file__apply_diff repeatedly needs explicit @@ line numbers in hunks (tool errors otherwise).
- prettier (pnpm lint) reformats tracked .drone-agent files and pnpm-lock.yaml — those formatting-only diffs ride along in the commit.
- Reflect persona uses `premountedTools` (not automountTools); premounting a defaultHidden tool makes it visible even without allowedTools (logs a warning only).

## Committed
- Branch feat/insight-lastExamined-tracking, commit 5d6a294.
