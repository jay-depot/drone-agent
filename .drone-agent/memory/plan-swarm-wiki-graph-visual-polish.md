---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T02:44:44.855Z
---

# Plan: Wiki graph view — visual polish (v2)

## Summary

Improve the visual legibility and exploration value of the coordinator wiki graph view (`/wiki?view=graph`, built in plan-swarm-wiki-graph-view, completed 2026-09-04). Exploration-first: zoom-tiered labels, importance-based node sizing, tag nodes organizing layout, dim-and-spotlight focus, zoom-compensated node sizing, on-canvas chrome.

User decisions locked during grilling (all confirmed):

1. **Exploration-first**; maintenance signals one toggle away.
2. **Zoom compensation for NODES ONLY** (refined round 4: links are engine-screen-scaled, must not be compensated).
3. Orphans always visible (toggle removed round 3), docked via tag-node attraction.
4. **Tag nodes as the only attraction mechanism**: green hollow rings, layout-active when hidden, `tag:<tag>` ids, clickable-to-focus.
5. **Labels**: `labelVisible = wikiLinkDegree ≥ threshold(zoom)`, threshold drops as zoom increases; threshold scales with the graph's degree distribution; hover tooltips universal. Degree counts wiki-link edges only.
6. **Page node size blend**: `0.7·normDegree + 0.3·log-normWords` → `(1+2i)^1.5`; server `wordCount` in `buildGraph()`.
7. **Focus = dim-and-spotlight** + camera move; kind-aware preview panel.
8. **Chrome kit**: legend, zoom-in/out/reset overlay, dashed amber broken-link edges, Tags toggle in header.
9. Defaults: auto-fit on engine stop once per data change; `tags=1` persisted only when non-default.

## COMPLETED 2026-09-06 — five rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation (wordCount server-side; utils rework; component rework with accessors-in-mount-effect over refs; page wiring). All gates green.
- **Round 2 (`1642021`)**: manual-smoke fixes — NaN camera poison (mount-time zoomToFit before positions existed; guarded all camera calls on finite positions, ignore non-finite onZoom); container wipe (`domNode.innerHTML = ''` — canvas into dedicated inner div, chrome as siblings); zoom-clamp floors below base (on-screen size is rel×k).
- **Round 3 (`8958d48`)**: Orphans toggle removed (tag attraction made it irrelevant; `filterOrphans` deleted); layout spread via d3Force getters (`WIKI_LINK_DISTANCE=90`, `WIKI_CHARGE_STRENGTH=-240`); **engine link-mutation fix** (force-graph rewrites edge source/target to node refs on the objects passed to graphData — broke page tag counts/broken-link styling/focus spotlight browser-only; component feeds shallow clones, accessors match by endpoint-resolved key); label thresholds scaled to graph degree distribution (`maxLabelThreshold`, ceil(0.35·max) clamped [2,10]).
- **Round 4 (`b85dab2`)**: link-width zoom compensation REMOVED (engine draws links in screen space: `lineWidth = width/globalScale`; our /k stacked a second scale — "effects stack badly"). Node compensation kept (nodes are graph-space). Tag nodes now sized by **absolute member page count** (`_val = members`, radius ∝ √members) instead of normalized share; page blend unchanged.
- Validation per round: tsc clean, UI suite green (120 tests after round 4), lint, build, root fast suite (2773), LSP clean.

## Notes / lessons

- **force-graph scaling model (round-4 verified)**: LINKS in screen space (`lineWidth = accessorWidth / globalScale` in engine) — never zoom-compensate link widths; NODES in graph space (`radius = sqrt(nodeVal) · nodeRelSize`, zoomed by transform) — consumer /k compensation is required to hold constant screen size. Diagnostic: edges look right at exactly one zoom level.
- **force-graph mutates edge objects passed to graphData** (link parse → node refs). Feed shallow clones; match by endpoint-resolved key (`edgeKey`/`edgeEndpointId`) in accessors. Signature: count always 0 / style never applies, browser-only, tests green.
- **Per-object absolute sizing beats normalized-share blends** when comparing absolute quantities across categories (tag = member count).
- **Scale absolute thresholds to the data's distribution** (labels: ceil(0.35·maxDegree) clamped [2,10]) or small graphs fall below them.
- **Ref-stored closure signatures must exactly match call sites** (TS param-count compatibility unsound in practice).
- **Camera calls guard on finite node positions**; canvas NaN asymmetry (nodes vanish, edges persist) is the diagnostic fingerprint.
- **Engine constructor wipes its mount element** — React chrome must be siblings of a dedicated inner mount div.
- **d3Force(name) with no fn is a getter** returning the live d3 force (verified in bundle + linkMethod pass-through).
- **LSP can go stale across file__write rewrites**; `tsc --noEmit` is ground truth for the UI package.
- **Manual smoke is not optional**: rounds 2, 3, and 4 all stemmed from user observation at the real canvas; unit suites were green each time.
- **apply_diff reliability**: on partial/interleaved application, stop diffing — read the full file and write the end state (or line-anchored python splice for large excisions).