---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T02:17:20.887Z
---

# Plan: Wiki graph view — visual polish (v2)

## Summary

Improve the visual legibility and exploration value of the coordinator wiki graph view (`/wiki?view=graph`, built in plan-swarm-wiki-graph-view, completed 2026-09-04). Exploration-first: zoom-tiered labels, importance-based node sizing, tag nodes organizing layout, dim-and-spotlight focus, zoom-compensated sizing, on-canvas chrome.

User decisions locked during grilling (all confirmed):

1. **Exploration-first**; maintenance signals one toggle away.
2. **Zoom compensation** via `onZoom` re-push of node/link sizing.
3. **Orphans visible by default**, docked via tag-node attraction. (Later: toggle removed entirely — see rounds.)
4. **Tag nodes as the only attraction mechanism**: green hollow rings, layout-active when hidden, `tag:<tag>` ids, clickable-to-focus.
5. **Labels**: `labelVisible = wikiLinkDegree ≥ threshold(zoom)`, threshold drops as zoom increases; hover tooltips universal. Degree counts wiki-link edges only.
6. **Node size blend**: `0.7·normDegree + 0.3·log-normWords` → `nodeVal = (1+2i)^1.5`; server `wordCount` added to `buildGraph()`.
7. **Focus = dim-and-spotlight** + camera move; kind-aware preview panel.
8. **Chrome kit**: legend, zoom-in/out/reset overlay, dashed amber broken-link edges, Tags toggle in header.
9. Defaults: auto-fit on engine stop once per data change; toggles persist in URL only when non-default (`tags=1`).

## COMPLETED 2026-09-06 — four rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation. wordCount server-side; utils rework (wikiLinkDegrees, buildAugmentedWikiGraph, applyNodeSizing, labelDegreeThreshold, buildFocusSets; buildFocusedSubgraph deleted); component rework (accessors-in-mount-effect over refs, nodeCanvasObjectMode('after') labels, dim-and-spotlight, chrome); page wiring (?tags=1, kind-aware preview). All gates green.
- **Round 2 (`1642021`)**: manual-smoke bug fixes — (1) NaN camera poison: mount-time zoomToFit ran before simulation positioned nodes; engine bbox math produced NaN that propagated through the engine's clamp chain into the d3 transform (nodes vanish via NaN radius, edges persist via canvas ignoring NaN lineWidth). All camera calls now guard on finite positions; non-finite onZoom ignored. (2) Container wipe: force-graph constructor does `domNode.innerHTML = ''` on its mount element — canvas now mounts into a dedicated inner div, chrome as siblings. (3) Zoom-compensation clamp floors were above base (huge first frames at engine auto-zoom 4/∛N); floors now below base; button k-bounds widened to [0.05, 10] (engine extent [0.01, 1000]).
- **Round 3 (`8958d48`)**: user feedback round — (a) Orphans toggle REMOVED (tag attraction made it irrelevant; `?orphans` + `filterOrphans` deleted as dead code). (b) Layout spread: link force distance 90, charge strength −240 via `d3Force` getters (engine-verified: getter form returns the live d3 force; tunable exported constants `WIKI_LINK_DISTANCE`/`WIKI_CHARGE_STRENGTH`). (c) **Engine link-mutation fix**: force-graph's link parsing rewrites `source`/`target` to node object references ON THE OBJECTS PASSED TO graphData — silently broke the page's string-based tag member count (always 0), broken-link styling, and focus spotlight in the browser while unit tests stayed green. Component now feeds engine shallow clones; canonical edges stay string-typed; per-frame accessors match edges by endpoint-resolved key (`edgeKey`/`edgeEndpointId` in utils). (d) Labels actually appearing: threshold now scales with the graph's degree distribution (`maxLabelThreshold = ceil(0.35·maxDegree)` clamped [2,10]) — the absolute ≥10 floor showed nothing on small graphs.

Validation per round: tsc --noEmit clean, UI vitest suite green (119 tests), root lint + build ×8 + fast suite (2773) green, LSP clean on touched files.

## Notes / lessons

- **force-graph engine vs react wrapper surface**: no `zoomIn`/`zoomOut` on the engine; `zoom(scale, ms)` + tracked zoomRef instead. `d3Force(name)` (no fn) is a getter returning the live d3 force. Verify everything against the installed `.d.ts` / bundle source.
- **force-graph mutates edge objects passed to graphData** (link parse → node refs; d3-force mutates further). Feed shallow clones; match by endpoint-resolved key in accessors. Diagnostic signature: count always 0 / style never applies, browser-only, tests green.
- **Ref-stored closure signatures must exactly match call sites** (TS param-count compatibility is unsound in practice — silently binds wrong args, NaN with zero type errors).
- **Camera calls must guard on finite node positions**; engine bbox math turns undefined positions into NaN that its own clamp chain propagates. Canvas asymmetry (NaN radius hides nodes, NaN lineWidth ignored on edges) is the diagnostic fingerprint.
- **Zoom-compensation clamps must floor below the base value** — on-screen size is rel×k, not rel alone.
- **The engine constructor wipes its mount element** (`domNode.innerHTML = ''`) — React chrome must be siblings of a dedicated inner mount div.
- **Scale any absolute threshold to the graph's own distribution** (degree here) or small datasets fall below it entirely.
- **LSP can go stale across file__write rewrites**; `tsc --noEmit` is ground truth for the UI package. Per-file diagnostics after re-touch; never trust one workspace-wide sweep.
- **Manual smoke is not optional**: rounds 2 and 3 were both invisible to the full unit suite and caught in minutes by the user at the real canvas.
- **apply_diff reliability**: when a multi-hunk patch partially applies or interleaves (this session: a block landed inside another function), stop diffing that file — read the full file, fix by full-file `file__write` with the end state, and prefer python/line-anchored splices for large test-file excisions.