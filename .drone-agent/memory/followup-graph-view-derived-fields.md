---
key: followup-graph-view-derived-fields
tags:
  - follow-up
  - seed
  - wiki
  - coordinator-ui
  - graph
  - performance
  - refactor
created: 2026-09-19T02:02:14.745Z
updated: 2026-09-19T02:36:33.815Z
---

# Follow-up seed: optimize the wiki graph view using the new derived fields

SEED/note only (recorded 2026-09-18 while planning `memory-wiki-browser-improvements`). The wiki-browser plan adds derived `wordCount` + `linkCount` to `DroneWikiPageMeta` (computed in `drone-swarm-common/src/wiki-storage.ts`, pre-cached, never persisted to frontmatter). Once those exist, revisit the graph view for opportunities to use them.

## Known opportunity (verified in the storage layer)

- `buildGraph()` (`drone-swarm-common/src/wiki-storage.ts:502`) currently DOUBLE-READS every page: it calls `listPages()` (which already `readPage`s each file) and then `readPage(meta.id)` again per page. Word count is recomputed inline (`page.content.split(/\s+/).filter(Boolean).length`).
- With `wordCount` on the meta, the graph can take the count from the meta instead of recomputing, and the shared `countWords` helper de-duplicates the logic.
- Caveat: `linkCount` alone does NOT replace the edge computation — `buildGraph` still needs the actual link _targets_ (edges) from page content, so a content read cannot be avoided entirely. The win is the avoided second read + shared helpers.
- Related: there is no per-page backlinks endpoint; the UI derives degree/backlinks client-side from the full graph (`lib/wiki-graph-utils.ts`).

## Also consider when revisiting

- `GET /api/wiki/tags` and `listTags()` recompute by loading all pages; same class of concern.
- Longer-term: client-side sort/filter/pagination on `GET /api/wiki` is not sustainable (the graph view is expected to hit the scaling wall first). A server-side sort/filter/pagination surface is a future concern (cf. ADR 189's server-side tag filtering).

## FOLDED IN: split `drone-coordinator-ui/src/components/wiki-graph.tsx` (deferred from the wiki-browser plan)

The wiki-browser plan deliberately made only a SURGICAL, ADDITIVE change to `wiki-graph.tsx` (add a filter/emphasis prop → mirrored ref → repaint effect) and DEFERRED splitting the file to this follow-up.

- `wiki-graph.tsx` is **1096 lines**, already over the project's 1000-line "must split" rule (AGENTS.md). `wiki-graph-utils.ts` is 355 lines.
- Why deferred, not done in the feature plan: the file's shape is DELIBERATE — one big mount effect with every canvas accessor closing over refs (force-graph's accessor/re-render model requires this; see [[drone-agent-coordinator-ui-wiki-graph-visual-polish]]). A split is a high-risk refactor guarded by 32 pinned tests in `wiki-graph.test.tsx` plus a **manual browser canvas smoke test** that cannot be automated. Bundling it into a feature plan would put the feature's validation at the mercy of an unrelated refactor.
- Suggested split shape (mechanical extraction, no behavior change): pure accessor factories + theme/color constants + the emphasis-set/dim predicate into their own modules; keep the component as the orchestration shell. Re-run `tsc --noEmit` (ground truth per the wiki page — vitest esbuild does not typecheck) and the 32 graph tests, plus the manual canvas smoke.
