---
key: plan-wiki-delete-coordinator-scope-fix
tags:
  - plan
  - beacon
  - wiki
  - swarm
created: 2026-09-10T15:11:16.210Z
updated: 2026-09-10T15:11:16.210Z
---

# Plan: Fix wiki_delete for coordinator-scoped pages (proxy + no-scope delete semantics)

## Summary
`swarm__wiki_delete` fails on coordinator-scoped pages. Two beacon-side root causes: (1) both proxy helpers in `drone-beacon/src/routes/context.ts` (`proxyToCoordinator`, `proxyWikiToCoordinator`, byte-identical) always send `Content-Type: application/json` even on bodyless DELETEs — Fastify 5.12.1 (coordinator) rejects with `400 FST_ERR_CTP_EMPTY_JSON_BODY`; the proxy collapses non-OK to `null` so the beacon returns a misleading 404 "Wiki page not found". GETs never hit the JSON parser, hence all other proxied ops work. Wire-level repro proved this. (2) The no-scope delete path deletes only the beacon-local copy — coordinator-only pages 404 and dual pages are half-deleted. Also affected (same helpers): coordinator-scope insight delete (`routes/insights.ts:113`) and principle delete (`routes/principles.ts:92`). Fragments are NOT affected (local-only DELETE; coordinator fragment route read-only).

## Agreed decisions
- (A) Proxy fix: set the CT header only when a body exists (precedent: `drone-beacon/src/outbox-flusher.ts:65-66`).
- (A) No-scope delete: delete both sides (coordinator 404 = nothing-to-do); success iff ≥1 side deleted; else 404. Mirrors no-scope read (all versions by origin); scope is a filter.
- Agent tool `wiki_delete` surfaces the beacon's error body (like wiki_write) and its description documents no-scope semantics.
- Extract one shared private proxy implementation; keep both exported names (~20 call sites).
- Accepted limitation (documented, not fixed): proxy collapses coordinator 5xx to null, indistinguishable from 404 — a no-scope delete during coordinator downtime can delete only the local half; wiki reindex reconcile cleans the drift.

## Steps (execution order)
1. `drone-beacon/src/routes/context.ts` — extract shared `proxyCall(method, path, body?)`; both exported helpers delegate to it. Header + body only when `body != null`; jsdoc cites FST_ERR_CTP_EMPTY_JSON_BODY + outbox-flusher precedent.
2. `drone-beacon/src/routes/wiki.ts` DELETE handler — scope=coordinator path unchanged (inherits header fix) + `triggerWikiReindex()` on success; no-scope path: `deletePage()` locally AND `proxyWikiToCoordinator('DELETE', ...)`; 404 only if neither side deleted; on success `triggerWikiReindex()` and return `{ success: true, beaconDeleted: boolean, coordinatorDeleted: boolean }`.
3. `drone-agent/src/plugins/swarm/tools-wiki.ts` — `wiki_delete` execute: on `!res.ok`, parse error body with fallback (`err.error || 'Failed to delete wiki page'`); update description to state no-scope deletes all versions (beacon + coordinator), scope narrows.
4. Tests (vitest):
   a. Proxy header behavior — fake coordinator client via `setCoordinatorClient({ getBaseUrl, getFetch: capturingSpy })` (see if `drone-beacon/test/coordinator-proxy.test.ts` already has one to reuse): bodyless DELETE sends no content-type header; bodyless GET unchanged; with-body sends CT.
   b. `drone-beacon/test/wiki-origin-reads.test.ts` pattern (setupDb, mkdtemp KB dir, buildTestApp, vi.mock context.js proxyWikiToCoordinator): coordinator-scope delete 200/null→404; no-scope beacon-only page (coordinator delete attempted); no-scope coordinator-only page → 200; no-scope dual page → both; no-scope missing everywhere → 404. Mock `wiki-index-support.js` (importOriginal + vi.fn for triggerWikiReindex) to assert reindex triggers.
5. Docs — new ADR `decisions/206-wiki-delete-coordinator-scope.md` in /home/unleet/Obsidian/drone-agent-project/decisions/ (format per ADR 205: frontmatter tags/related, Summary, Context, Decision, Implementation, Tests, Key Points, Related); update `decisions/index.md` (count → 206, latest pointer); update `modules/drone-beacon.md` (proxy fix + no-scope delete) and `modules/drone-agent-plugins.md` (wiki_delete error surfacing); search coordinator wiki for pages still documenting this bug/workaround (ex wiki-tooling-notes) and update via `wiki_write` (dogfooding the fixed tool).
6. Final step: check all work against Validation criteria below.

## Validation criteria
- LSP clean across workspace.
- `pnpm -r run lint` (eslint + prettier) zero errors; re-read files after prettier before any further edit.
- `pnpm -r run build` zero errors.
- `pnpm -r run test` (fast suite) passes, including all new tests from step 4.
- Manual smoke (swarm running): `swarm__wiki_delete {pageId, scope:'coordinator'}` succeeds and the page disappears from `wiki_list`; no-scope delete on a dual page removes both versions.