---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T01:36:57.589Z
---

# Plan: Wiki graph view — visual polish (v2)

## Summary

Improve the visual legibility and exploration value of the coordinator wiki graph view (`/wiki?view=graph`, built in plan-swarm-wiki-graph-view, completed 2026-09-04). Today the graph renders anonymous same-size dots, no labels, no initial zoom fit, orphans scattered to the periphery, and a focus mode that barely changes pixels. This plan makes the graph exploration-first: named nodes with zoom-tiered labels, size encoding importance, tag nodes that organize layout, a real dim-and-spotlight focus, zoom-compensated node/link sizing, and on-canvas chrome (legend, zoom controls, toggles).

User decisions locked during grilling (all confirmed):

1. **Exploration-first**; maintenance signals stay one toggle away.
2. **Zoom compensation**: node/link size re-pushed on `onZoom` so nodes keep a near-constant screen size when zoomed out (currently a one-shot global `nodeRelSize`).
3. **Orphans visible by default**, docked near their topical neighborhoods via tag-node attraction; toggle (URL-persisted when off) hides them + re-fits view.
4. **Tag nodes as the only attraction mechanism** (supersedes any page↔page overlap-edge idea): pages tether to tag nodes; when tags are hidden the tag layer stays in layout (invisible, still attracting). Tag nodes: **hollow rings, nice green** (e.g. `#22c55e` dark / `#16a34a` light), always labeled when visible, clickable-to-focus.
5. **Labels**: `labelVisible = degree ≥ threshold(zoom)`; threshold drops as zoom increases (mega-hubs named when zoomed out; everything named zoomed in). Hover tooltip universal. Degree counts **wiki-link edges only** (tag edges excluded from degree math everywhere).
6. **Node size = blended importance**: `0.7·normDegree + 0.3·normWords` (normDegree = degree/maxDegree; normWords = `log10(1+words)/log10(1+maxWords)`), then `nodeVal = (1 + SPREAD·importance)^1.5` (SPREAD≈2, tunable). Requires server `wordCount` (additive; `buildGraph()` already reads all page content).
7. **Focus = dim-and-spotlight**: full graph always renders (no more subgraph data swap); non-neighbors dim, touching edges brighten/thicken, focused node gets a ring, camera moves to the node (`centerAt` + zoom). Tag nodes focusable (neighborhood = member pages); preview panel must handle tag nodes (no "Open full page").
8. **Chrome kit**: legend (blue dot page / green ring tag / amber dot broken / dashed amber = link to missing page), zoom-in/out/reset overlay buttons, dashed amber broken-link edges, header toggles next to Grid/Graph.
9. Defaults: auto-fit on engine stop (once per data change), toggles persist in URL only when non-default (`orphans=0`, `tags=1`), tag node id namespace `tag:<tag>` to avoid page-id collisions.

## Files touched

- `drone-swarm-common/src/wiki-storage.ts` (+ `test/wiki-storage.test.ts`)
- `drone-coordinator-ui/src/lib/types.ts`
- `drone-coordinator-ui/src/lib/wiki-graph-utils.ts` (rework; delete `buildFocusedSubgraph`) (+ test)
- `drone-coordinator-ui/src/components/wiki-graph.tsx` (rework) (+ test)
- `drone-coordinator-ui/src/pages/wiki.tsx` (+ test)

## Steps (all implemented)

- **Step 1** `wordCount` on `WikiGraphNode`, populated in `buildGraph()` (0 on placeholders); rebuild gate before UI work.
- **Step 2** UI types: `wordCount` mirror + `GraphNodeKind`/`AugmentedGraphNode` (`_val`)/`AugmentedGraphEdge`/`AugmentedWikiGraph`.
- **Step 3** Utils rework: `wikiLinkDegrees`, `buildAugmentedWikiGraph`, `filterOrphans`, `applyNodeSizing`, `labelDegreeThreshold` + constants, `buildFocusSets`; `buildFocusedSubgraph` deleted. 19 unit tests.
- **Step 4** Component rework: accessors inside mount effect over refs; `onZoom` compensation; dim-and-spotlight + camera; dashed amber broken edges; legend + zoom buttons; auto-fit on engine stop. 17→19 component tests.
- **Step 5** Page wiring: `?orphans=0`/`?tags=1`, Tags/Orphans toggles, kind-aware preview, prop-capturing stub. 7 page tests.
- **Step 6** Validation: typecheck, lint, build ×8, root fast suite 2773 passed, UI suite 115 passed (117 after fix round), LSP clean.

## COMPLETED 2026-09-06 (commits `de9bdef`, then fix round `1642021` on `feat/memory-wiki-browser-improvements`; checkpoint `6f491c1`)

All automatable validation gates passed. Manual browser smoke caught three real bugs, fixed in `1642021`:

1. **NaN camera poison**: the mount-time `zoomToFit` ran before the simulation positioned any node; `getGraphBbox` computed `undefined - r = NaN` and the engine's `Math.max/min` clamp chain propagated NaN into the d3 transform. The `onZoom` NaN storm drove `nodeRelSize(NaN)`: nodes vanish (NaN radius draws nothing), edges persist (canvas ignores NaN `lineWidth`) — the exact reported asymmetry ("dots vanish after a frame, edges stay, camera stuck top-left, zoom/drag dead"). Fix: every camera call guarded on finite node positions (mount fit, engine-stop auto-fit, refit-on-clear); non-finite `onZoom` transforms ignored; `applyZoomStyles` NaN-proof.
2. **Container wipe**: force-graph's constructor does `domNode.innerHTML = ''` on its mount element, destroying the React-rendered legend and zoom buttons (the "legend doesn't show up" report). Fix: canvas mounts into a dedicated inner `div` (absolute inset-0); legend/buttons are siblings, never children of the mount target.
3. **Zoom clamp floors above base**: `clamp(6/k, 3, 12)` — the floor 3 exceeds base 6/k for k>2, so at the engine's initial auto-zoom (`ZOOM2NODES_FACTOR/cbrt(N)` ≈ 17 for small N) nodes rendered ~8× on-screen size ("huge dots"). Fix: floors below base — rel size [0.35, 20], link width [0.08, 6]; zoom-button k bounds widened to [0.05, 10] (engine extent is [0.01, 1000]) so buttons no longer fight the wheel.

Regression tests added: non-finite zoom transforms ignored; camera fits skipped until positions exist (mount, engine-stop, refit paths). UI suite 117 passing after fix round.

## Notes / lessons

- **force-graph engine vs react wrapper surface**: no `zoomIn`/`zoomOut` on the engine (react-force-graph props only); `zoom(scale, ms)` + tracked `zoomRef` is the engine-idiomatic equivalent. Verify against the installed `.d.ts`, not docs.
- **Ref-stored closures: TS parameter-count compatibility is unsound in practice** — a 1-param closure assigned to a 2-param ref type compiles, and `ref.current(fg, k)` silently binds `fg` into the closure's `k` (NaN with zero type errors). Keep ref-stored signatures exactly matching call sites.
- **LSP diagnostics can go stale across `file__write` rewrites**; `tsc --noEmit` is ground truth for the UI package. Use per-file `lsp__get_diagnostics` after re-touching; never trust a workspace-wide sweep alone.
- **Orphan-hood is wiki-link degree, not total edge degree** — a tag-only page IS an orphan. Test fixtures must tag edge kinds precisely.
- **Engine source over assumptions**: the container wipe, NaN bbox, auto-zoom formula, and scaleExtent were all confirmed by reading `node_modules/force-graph/dist/force-graph.mjs` before fixing — worth the two greps every time.
- **Manual smoke is not optional**: all three bugs were invisible to 117 unit tests (jsdom canvas + fake handle) and caught in seconds by a human at the real canvas.
