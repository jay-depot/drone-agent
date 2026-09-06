---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T03:27:47.454Z
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
10. **Rounds 5–7 (user requests)**: tag clusters repel each other but bind members tight; big tags need disproportionate separation.

## COMPLETED 2026-09-06 — seven rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation.
- **Round 2 (`1642021`)**: manual-smoke fixes — NaN camera poison; container wipe; zoom-clamp floors.
- **Round 3 (`8958d48`)**: Orphans toggle removed; layout spread; engine link-mutation fix (shallow clones + endpoint-key matching); label thresholds scaled to degree distribution.
- **Round 4 (`b85dab2`)**: link-width zoom compensation removed; tag nodes sized by absolute member count.
- **Round 5 (`cd3ce3d`)**: per-kind layout forces — tag springs (55/strength 1), page springs stock via `d3DefaultLinkStrength`, tag charge −700 + distanceMax.
- **Round 6 (`adb6785`)**: tag-expulsion bug fix (charge is scalar per node; boosted charge repelled tags from own members → periphery halo). Custom `createTagRepulsionForce` (tag↔tag-only, distance-capped, bounded coincident fallback) registered via `d3Force('tagRepulsion', fn)`; charge back to −240.
- **Round 7 (`d1d7328`)**: big tags still clumped — their many strength-1 member springs anchor them to the same centroid when member sets overlap, overpowering the uniform kick. Fix: (a) tag↔tag inverse-square scales by geometric mean of member counts (√(mA·mB); 12-member tags repel 12× harder), base 300→900; (b) soft exclusion shell sized by rendered radii (engine: √val·relSize/2, zoom-compensated ⇒ graph-space radius √val·3) + 4.5 margin, spring-like push 40·overlap·alpha — crowding geometrically impossible; (c) per-pair kick clamp 25/tick for stability.
- Validation per round: tsc clean, UI suite green (127 tests), lint, build, root fast suite (2773), LSP clean.

## Tuning knobs (all in wiki-graph-utils.ts)

`WIKI_LINK_DISTANCE` 90 · `WIKI_CHARGE_STRENGTH` −240 · `WIKI_TAG_LINK_DISTANCE` 55 · `WIKI_TAG_SPRING_STRENGTH` 1 · `WIKI_TAG_REPULSION_STRENGTH` 900 · `WIKI_TAG_REPULSION_DISTANCE_MAX` 500 · `WIKI_TAG_MIN_SEPARATION_SCALE` 4.5 · `WIKI_TAG_SEPARATION_STRENGTH` 40 · `WIKI_TAG_MAX_KICK` 25 · `NODE_SIZE_SPREAD` 2 · `LABEL_THRESHOLD_*` (0.75 / 2.5 / 10 / 0.35).

## Notes / lessons

- **many-body charge is scalar per node** — cannot repel a group from itself only; use a custom force via `d3Force(name, fn)`. Contract: `(alpha) => void` mutating vx/vy, `initialize(nodes)` re-run on graphData push.
- **Springs vs repulsion balance**: a big tag's member springs scale with member COUNT (many strength-1 springs), so separation forces must scale with size too — geometric-mean weighting √(mA·mB) on the inverse-square term. For hard guarantees (no overlap), add a positional-exclusion shell keyed to RENDERED radii, not abstract distances.
- **Clamp kicks** when stacking strong force terms (25/tick) — inverse-square × size-scaling × shell can launch nodes.
- **d3 accessor outputs are unary-plussed** — undefined = NaN. Reproduce stock defaults in fallback branches.
- **force-graph mutates edge objects passed to graphData** — shallow clones + endpoint-key matching.
- **LINKS screen-space / NODES graph-space** in force-graph rendering — only compensate nodes on zoom.
- **Camera calls guard on finite positions**; engine constructor wipes mount element; LSP stale across file__write; `tsc --noEmit` is ground truth.
- **Manual smoke is not optional**: rounds 2, 3, 4, 6, 7 all originated from user observation/screenshot at the real canvas.
- **apply_diff reliability**: ADD-only hunks create duplicates (happened twice this session); on any suspicion, grep for duplicated blocks and read the full region before continuing.