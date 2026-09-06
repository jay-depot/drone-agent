---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T03:03:53.348Z
---

# Plan: Wiki graph view — visual polish (v2)

## Summary

Improve the visual legibility and exploration value of the coordinator wiki graph view (`/wiki?view=graph`, built in plan-swarm-wiki-graph-view, completed 2026-09-04). Exploration-first: zoom-tiered labels, importance-based node sizing, tag nodes organizing layout, dim-and-spotlight focus, zoom-compensated node sizing, on-canvas chrome.

User decisions locked during grilling (all confirmed):

1. **Exploration-first**; maintenance signals one toggle away.
2. **Zoom compensation for NODES ONLY** (links are engine-screen-scaled).
3. Orphans always visible (toggle removed round 3), docked via tag-node attraction.
4. **Tag nodes as the only attraction mechanism**: green hollow rings, layout-active when hidden, `tag:<tag>` ids, clickable-to-focus.
5. **Labels**: `labelVisible = wikiLinkDegree ≥ threshold(zoom)`, threshold drops as zoom increases; scales with the graph's degree distribution; hover tooltips universal. Degree counts wiki-link edges only.
6. **Page node size blend**: `0.7·normDegree + 0.3·log-normWords` → `(1+2i)^1.5`; server `wordCount` in `buildGraph()`.
7. **Focus = dim-and-spotlight** + camera move; kind-aware preview panel.
8. **Chrome kit**: legend, zoom-in/out/reset overlay, dashed amber broken-link edges, Tags toggle in header.
9. Defaults: auto-fit on engine stop once per data change; `tags=1` persisted only when non-default.

## COMPLETED 2026-09-06 — six rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation (wordCount server-side; utils rework; component rework with accessors-in-mount-effect over refs; page wiring). All gates green.
- **Round 2 (`1642021`)**: manual-smoke fixes — NaN camera poison (guard all camera calls on finite positions; ignore non-finite onZoom); container wipe (`domNode.innerHTML = ''` — canvas into dedicated inner div, chrome as siblings); zoom-clamp floors below base.
- **Round 3 (`8958d48`)**: Orphans toggle removed; layout spread via d3Force getters; **engine link-mutation fix** (feed shallow clones; accessors match by endpoint-resolved key); label thresholds scaled to graph degree distribution.
- **Round 4 (`b85dab2`)**: link-width zoom compensation REMOVED (engine screen-scales links; /k stacked a second scale). Tag nodes sized by absolute member page count (radius ∝ √members).
- **Round 5 (`cd3ce3d`)**: **per-kind layout forces** — tag edges = short stiff springs (distance 55, strength 1) binding member pages into tight topical clusters; page edges = d3's stock spring reproduced as an accessor (`d3DefaultLinkStrength` = 1/min total-layout-edge degree, per-endpoint-degree map kept in a ref); tag nodes = stronger charge (−700 vs −240) pushing whole clusters apart; charge `distanceMax` capped at 420 so close-range repulsion can't overpower the springs. Verified in d3-force-3d 3.0.6 source that link strength/distance and manyBody strength are per-element ACCESSORS consumed by unary plus — accessors must return finite numbers for every element.
- Validation per round: tsc clean, UI suite green (122 tests), lint, build, root fast suite (2773), LSP clean.

## Notes / lessons

- **force-graph scaling model**: LINKS in screen space (`lineWidth = width/globalScale` in engine) — never zoom-compensate link widths; NODES in graph space — consumer /k compensation required. Diagnostic: edges look right at exactly one zoom level.
- **d3 forces take per-element accessors**, not just constants: `linkForce.strength/distance(fn)`, `chargeForce.strength(fn)`, `chargeForce.distanceMax(n)`. Accessor outputs are unary-plussed — returning undefined = NaN forces = layout explosion. Reproduce d3 defaults (link strength 1/min-degree) in the accessor's fallback branch.
- **force-graph mutates edge objects passed to graphData** (link parse → node refs). Feed shallow clones; match by endpoint-resolved key (`edgeKey`/`edgeEndpointId`). Signature: count always 0 / style never applies, browser-only, tests green.
- **Per-object absolute sizing beats normalized-share blends** when comparing absolute quantities (tag = member count).
- **Scale absolute thresholds to the data's distribution** (labels: ceil(0.35·maxDegree) clamped [2,10]).
- **Ref-stored closure signatures must exactly match call sites** (TS param-count compatibility unsound).
- **Camera calls guard on finite node positions**; canvas NaN asymmetry (nodes vanish, edges persist) is the fingerprint.
- **Engine constructor wipes its mount element** — React chrome must be siblings of a dedicated inner mount div.
- **d3Force(name) with no fn is a getter**; with fn, a setter (verified in bundle).
- **LSP can go stale across file__write rewrites**; `tsc --noEmit` is ground truth for the UI package.
- **Manual smoke is not optional**: rounds 2–4 all stemmed from user observation at the real canvas.
- **apply_diff reliability**: on partial/interleaved application, stop diffing — full-file write of the end state, or line-anchored python splice for large excisions. Watch for patches that ADD lines without corresponding `-` lines (creates duplicates).