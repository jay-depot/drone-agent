---
tags: [decision, drone-swarm-common, drone-coordinator, drone-coordinator-ui, wiki, graph, force-graph]
related: [modules/drone-swarm-common.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-coordinator-ui.md, concepts/memory-pipeline.md, decisions/187-coordinator-ui-wiki-browser-improvements.md, decisions/189-coordinator-wiki-tag-scaleup.md]
---

# 194: Connected node graph view for the wiki browser

**Status**: Implemented (2026-09-04, branch `feat/memory-wiki-browser-improvements`, from completed plan `plan-swarm-wiki-graph-view`)

## Context

The wiki browser ([187-coordinator-ui-wiki-browser-improvements](187-coordinator-ui-wiki-browser-improvements.md),
[189-coordinator-wiki-tag-scaleup](189-coordinator-wiki-tag-scaleup.md)) had list/grid/tag views but no
way to *see* the wiki's link structure: orphans, broken `[[wikilinks]]`, and
page neighborhoods were only discoverable through `POST /wiki/lint` output.
The memory wiki is a densely cross-referenced corpus (memory-pipeline),
and its structure is itself information.

## Decision

Add an interactive force-directed graph view to the `/wiki` page, backed by a
coordinator-only graph endpoint.

1. **Graph computation** (`drone-swarm-common/src/wiki-storage.ts`): new
   `buildGraph()` (sibling of `lintPages()`) reusing the private
   `extractWikiLinks`. All pages are nodes (orphans included); edges are the
   forward `[[wikilink]]` targets, deduplicated; broken-link targets become
   placeholder nodes with `exists: false` so missing pages stay addressable
   and visible for maintenance. `wordCount` is carried per node (consumed by
   the UI's sizing). `buildGraph` must `readPage` every page — `listPages`
   meta carries `pitch`/`wordCount` but not content.
2. **Endpoint** (`drone-coordinator/src/routes/wiki.ts`):
   `GET /wiki/graph` returns `{ nodes, edges }` from the coordinator's own
   store — self-consistent with `GET /wiki`, no beacon proxy, no cross-scope
   merge. Registered **before** `/wiki/:pageId` so Fastify's static route wins
   over the param route.
3. **Library** (`drone-coordinator-ui`): `force-graph` **v1.51.4 directly** —
   the underlying engine `react-force-graph` wraps. Plan deviation
   (user-approved): `react-force-graph` is uninstallable under pnpm 11.8's
   `blockExoticSubdeps` supply-chain policy (its transitive
   `3d-force-graph-vr → aframe → three-bmfont-text` uses a git-resolved dep).
   Check any future candidate library's transitive deps for git-resolved
   subdeps before promising the package.
4. **Wrapper architecture**: the imperative engine is isolated behind
   `components/wiki-graph.tsx` (instantiate in `useEffect`, chain setters,
   `_destructor()` on cleanup) with an **injectable `forceGraphFactory`** so
   tests exercise data-shaping and navigation callbacks against a fake handle,
   never the canvas. `hooks/use-wiki-graph.ts` gates the fetch with an
   `enabled` param (hooks run unconditionally; the fetch must not fire in grid
   view).
5. **Page integration** (`pages/wiki.tsx`): `?view=graph` toggles grid ⇄ graph
   (URL-persisted, sessions-style button); `?node=<pageId>` persists the
   focused node so browser back restores mode + focus. Click node → focus;
   preview panel; "Show all" resets; background click clears.
6. **jsdom cannot render force-graph**: page tests stub the component;
   the wrapper is unit-tested via the injected fake factory.

## Consequences

- The wiki's link graph is explorable, with orphans and broken links visible
  as first-class nodes.
- All further graph rendering work (sizing, labels, forces, focus, animation)
  lives in the wrapper + `lib/wiki-graph-utils.ts`
  ([195-wiki-graph-visual-polish](195-wiki-graph-visual-polish.md)).

## Tests

- `drone-swarm-common/test/wiki-storage.test.ts`: +5 (nodes/edges/round-trip,
  orphans, `exists:false` placeholders, dedup).
- `drone-coordinator/test/wiki-routes.test.ts`: graph endpoint test.
- `drone-coordinator-ui`: 4 `wiki-graph-utils` units, 5 component tests (fake
  handle), 2 page tests (graph-view fetch + grid-view no-fetch).

## Related

- [195-wiki-graph-visual-polish](195-wiki-graph-visual-polish.md) — the rendering work built on this
- [187-coordinator-ui-wiki-browser-improvements](187-coordinator-ui-wiki-browser-improvements.md) — the wiki browser
- [189-coordinator-wiki-tag-scaleup](189-coordinator-wiki-tag-scaleup.md) — tag pages/list filtering
