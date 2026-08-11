---
key: insight-lastExamined-tracking-plan
tags:
  - plan
  - self-improvement
  - insights
  - principles
created: 2026-08-11T00:37:00.632Z
updated: 2026-08-11T00:37:00.632Z
---

# Plan: Insight lastExamined Tracking for the Promotion Process

## Summary

Add an optional/nullable `lastExamined` timestamp to all insight entries (local file-based + swarm SQLite), plus a hidden-by-default tool that the insights→principles promotion process (e.g. reflect persona) premounts to mark a target's insights as examined "as of now."

## Design decisions

1. Separate hidden tool `self-improvement__mark_examined`, `defaultHidden: true`, premounted only by the promotion persona (not added as an action on the existing insight tool).
2. "Mark all in target as of now" — sets `lastExamined` on every entry of the given target.
3. Server-side timestamp for swarm — beacon/coordinator compute `now`; no caller-passed timestamp.
4. Overwrite-all — re-marking bumps `lastExamined = now` on all entries (new insights after a mark have no lastExamined = unexamined).

## Steps

1. **drone-core** `capabilities.ts`: add `lastExamined?: string` to `DroneInsightEntry`; add `markInsightsExamined(targetType,targetId): Promise<{ok;markedCount}>` to `DroneInsightStorageEngine`. Run `pnpm -r run build` after. Sweep implementers: file-engine.ts + swarm/hooks.ts (no test mocks exist).
2. **file-engine.ts**: add markInsightsExamined — within withFileLock, set e.lastExamined=now on all entries, writeJsonArrayAtomic, return markedCount.
3. **swarm beacon+coordinator**: (a) idempotent migration in init.ts (PRAGMA table_info check + ALTER TABLE ADD COLUMN lastExamined TEXT; also add to CREATE TABLE for fresh DBs); (b) add lastExamined to InsightRow + markInsightsExamined() SQL UPDATE; (c) add POST /insights/mark-examined route (coordinator direct; beacon proxies scope=coordinator).
4. **swarm/hooks.ts**: add lastExamined passthrough to readInsights/listInsights; add markInsightsExamined HTTP POST to /insights/mark-examined.
5. **New tool** `tools/mark-examined.ts` (createMarkExaminedTool): defaultHidden:true, validateTarget, resolveInsightEngine, call engine.markInsightsExamined. Register in index.ts.
6. **Promotion persona (reflect)** premounts self-improvement\_\_mark_examined (premountedTools + allowedTools).
7. **Tests**: drone-agent/test/self-improvement (mark_examined: set lastExamined, no-op on empty target, overwrite, new-insight-unexamined, defaultHidden absent until premounted); beacon + coordinator db.test.ts (markInsightsExamined CRUD); route tests for POST /insights/mark-examined incl 400 + beacon→coordinator proxy.
8. **Validation**: LSP pass, pnpm -r build/typecheck/lint/test pass, grep sweep confirms both engines have markInsightsExamined, verify reflect premounts it + tool is defaultHidden.

## Open check for executor

Confirm exact reflect persona file location and premountedTools/allowedTools shape before editing (step 6).
