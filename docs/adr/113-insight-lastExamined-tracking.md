---
tags: [decision, self-improvement, insights, swarm]
related: [concepts/self-improvement.md, modules/drone-core.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-agent-plugins.md, decisions/013-swarm-insights-principles.md, decisions/112-self-improvement-file-write-race-fix.md]
---

# ADR 113: Insight `lastExamined` Tracking for the Promotion Process

**Status**: Implemented (commit `5d6a294`, 2026-08-11, branch `feat/insight-lastExamined-tracking`)

## Context

The self-improvement system records insights about personas, skills, and the project. The insights→principles **promotion process** (e.g. the `reflect` persona) periodically reviews a target's accumulated insights and decides which recurring themes to promote into principles. There was **no way to track which insights had already been examined** — every review pass re-examined everything, making each pass noisy and forcing manual workarounds (a project-memory "processing tracker") to remember dispositions.

## Decision

Add an optional/nullable **`lastExamined`** timestamp to every insight entry — both local file-based insights and swarm SQLite-stored insights — and expose a **hidden-by-default tool** that the promotion process premounts to mark a target's insights as examined "as of now."

### 1. Data model (`drone-core`)

- `DroneInsightEntry` gains `lastExamined?: string` (ISO-8601). `undefined` = never examined.
- `DroneInsightStorageEngine` gains `markInsightsExamined(targetType, targetId): Promise<{ ok, markedCount }>`.

### 2. File engine (`drone-agent`)

`file-engine.ts` implements `markInsightsExamined`: within `withFileLock`, set `entry.lastExamined = now` on every entry, then `writeJsonArrayAtomic` (skipping the write when there are zero entries to avoid an ENOENT on a nonexistent target directory). Reuses the existing per-file mutex + atomic-write hardening from [[decisions/112-self-improvement-file-write-race-fix]].

### 3. Swarm storage (beacon + coordinator)

- **Schema**: `lastExamined TEXT` column added to the `insights` table in both `init.ts` files, plus an **idempotent migration** — `PRAGMA table_info(insights)` check followed by `ALTER TABLE insights ADD COLUMN lastExamined TEXT`. There is no migration framework in either package, so this lightweight PRAGMA+ALTER pattern is the established approach.
- **CRUD**: `markInsightsExamined()` SQL `UPDATE insights SET lastExamined = ? WHERE targetType = ? AND targetId = ?`.
- **Route**: `POST /insights/mark-examined` (coordinator handles directly; beacon proxies `scope=coordinator` to the coordinator, mirroring the existing `POST /insights` pattern). Server computes `now`.

### 4. Swarm HTTP engine (`drone-agent`)

`swarm/hooks.ts` adds `lastExamined` passthrough on `readInsights`/`listInsights` and a `markInsightsExamined` HTTP POST to `/insights/mark-examined`.

### 5. Hidden tool

New `self-improvement__mark_examined` tool (`tools/mark-examined.ts`), **`defaultHidden: true`** — so random agents don't misuse it. It calls `validateTarget` + `resolveInsightEngine` (so it routes to file vs. swarm engine by target scope) then `engine.markInsightsExamined`. The promotion persona (reflect) premounts it via `premountedTools`.

## Design decisions

- **Separate tool, not a new action** on the existing `self-improvement__insight` tool — a dedicated `defaultHidden` tool is gated so only a trusted, premounting persona can invoke it.
- **"Mark all in target as of now"** — the operation sets `lastExamined` on every entry of the given target, matching the review-pass workflow and sidestepping the file-vs-swarm entry-addressing mismatch (files are index-addressed; swarm rows are UUID-addressed).
- **Server-side timestamp** — beacon/coordinator compute `now`; no caller-passed timestamp (single source of time, no clock skew).
- **Overwrite-all** — re-marking bumps `lastExamined = now` on all entries; newly recorded insights after a mark have no `lastExamined` and so remain "unexamined."

## Consequences

### Positive

- The promotion process can mark a target's insights examined after a review, and future passes only re-examine insights with no/older `lastExamined`.
- Works uniformly for local file-based and swarm SQLite insights.
- `recall`/`list` output surfaces `lastExamined` naturally via the `DroneInsightEntry` type change.

### Neutral

- File-based and swarm insights remain addressed differently (index vs. UUID), but the whole-target "mark as of now" operation avoids needing to reconcile this.

### Note (persona frontmatter key)

While wiring up the reflect persona, discovered it used `automountTools:` as its premount frontmatter key — **an unsupported key that the persona loader silently ignores** (loader.ts only recognizes `premountedTools:`). This was a typo in the user's file; it was renamed to `premountedTools:` and `mark_examined` added under `self-improvement`. Unknown frontmatter keys are silently dropped, which can make premounts appear broken with no error.

## Tests

- `drone-agent/test/self-improvement/mark-examined.test.ts` (new, 6 tests): hidden-by-default (absent from `listTools`), sets `lastExamined` on all entries, empty-target → markedCount 0 (guards the ENOENT fix), overwrite on re-mark, new-insight-remains-unexamined, recall surfaces `lastExamined`.
- `drone-beacon/test/db.test.ts` + `drone-coordinator/test/db.test.ts`: `markInsightsExamined` CRUD (marks all for a target, markedCount 0 for empty).
- Beacon + coordinator route tests for `POST /insights/mark-examined` incl. the 400 validation.

**Validation**: build/typecheck/lint clean; 1787 tests pass (9 pre-existing skips); LSP clean; grep sweep confirmed both `DroneInsightStorageEngine` implementers (`file-engine.ts`, `swarm/hooks.ts`) carry the new method.

## Related

- [[concepts/self-improvement]] — The insight/principle system this extends
- [[modules/drone-core]] — `DroneInsightEntry` / `DroneInsightStorageEngine`
- [[decisions/013-swarm-insights-principles]] — Swarm-wide insights/principles promotion
- [[decisions/112-self-improvement-file-write-race-fix]] — Concurrency hardening reused by the file-engine mark operation
- [[concepts/default-hidden-tools]] — Why `defaultHidden` gating matters
