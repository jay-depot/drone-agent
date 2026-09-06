---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T03:17:23.542Z
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
10. **Round 6 (user request)**: tag nodes repel each other strongly but attract their members strongly (implemented via per-kind link accessors + a dedicated tag↔tag repulsion force).

## COMPLETED 2026-09-06 — six rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation (wordCount server-side; utils rework; component rework with accessors-in-mount-effect over refs; page wiring).
- **Round 2 (`1642021`)**: manual-smoke fixes — NaN camera poison (guard camera calls on finite positions; ignore non-finite onZoom); container wipe (`domNode.innerHTML = ''`); zoom-clamp floors below base.
- **Round 3 (`8958d48`)**: Orphans toggle removed; layout spread via d3Force getters; engine link-mutation fix (shallow clones into graphData; accessors match by endpoint-resolved key); label thresholds scaled to degree distribution.
- **Round 4 (`b85dab2`)**: link-width zoom compensation removed (engine screen-scales links). Tag nodes sized by absolute member count (radius ∝ √members).
- **Round 5 (`cd3ce3d`)**: per-kind layout forces — tag edges short stiff springs (55 / strength 1); page edges stock d3 springs via `d3DefaultLinkStrength` accessor; tag charge boosted to −700 + distanceMax cap.
- **Round 6 (`adb6785`)**: **fixed the tag-expulsion bug from round 5** — user screenshot showed green tags scattered around the periphery instead of centered in clusters. Root cause: many-body charge is a scalar per node; boosting tag charge repelled tags from their OWN members (the dense page blob shoved tags outward, springs dangled behind). Fix: custom d3-compatible force `createTagRepulsionForce` (tag↔tag-only repulsion, O(n²), distance cap 500, unit-distance fallback for coincident pairs with bounded kick) registered via `d3Force('tagRepulsion', force)`; tag charge back to uniform −240. Verified d3 force contract in source: `(alpha) => void` mutating velocities; `initialize(nodes)` re-run by `simulation.nodes()` on every graphData push; forces called via `forces.forEach(force => force(alpha))`.
- Validation per round: tsc clean, UI suite green (125 tests), lint, build, root fast suite (2773), LSP clean.

## Notes / lessons

- **many-body charge CANNOT implement "repel only group X from itself"** — it is a scalar per node and applies to every pair the node participates in. Boosting a group's charge also repels it from its own neighbors. For selective repulsion, register a custom d3 force via `d3Force(name, fn)`; the contract is `(alpha) => void` mutating `vx/vy`, plus optional `initialize(nodes)` (re-run by `simulation.nodes()` on every graphData push). Guard coincident nodes: the k/distSq kick explodes near zero — fall back to a bounded unit-distance push.
- **d3 forces take per-element accessors** (link strength/distance, charge strength); accessor outputs are unary-plussed — undefined = NaN forces. Reproduce d3 defaults (link strength 1/min-degree) in fallback branches.
- **force-graph scaling model**: LINKS screen-space (`lineWidth = width/globalScale` in engine) — never zoom-compensate; NODES graph-space — /k compensation required.
- **force-graph mutates edge objects passed to graphData** — feed shallow clones; match by endpoint-resolved key (`edgeKey`).
- **Engine constructor wipes its mount element** — React chrome as siblings of a dedicated inner mount div.
- **Camera calls guard on finite node positions**; canvas NaN asymmetry (nodes vanish, edges persist) is the fingerprint.
- **Per-object absolute sizing beats normalized-share blends** for cross-category comparison (tag = member count).
- **Scale absolute thresholds to the data's distribution** (labels: ceil(0.35·maxDegree) clamped [2,10]).
- **Manual smoke is not optional**: rounds 2, 3, 4, and 6 all originated from user observation at the real canvas (screenshot diagnosis is high-value: the tag-periphery pattern was legible directly from the image).
- **LSP can go stale across file__write rewrites**; `tsc --noEmit` is ground truth for the UI package.
- **apply_diff reliability**: partial/interleaved application happens (watch for ADD-only hunks creating duplicates); on trouble, read full file and write the end state.