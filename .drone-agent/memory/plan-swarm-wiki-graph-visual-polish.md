---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T14:00:16.344Z
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
10. **Rounds 5–8 (user requests)**: tag clusters repel each other but bind members tight; big tags need disproportionate separation; tag→page attraction inversely proportional to tag size; page-page links exert no force.

## COMPLETED 2026-09-06 — seven rounds on `feat/memory-wiki-browser-improvements`

- **Round 1 (`de9bdef`)**: full plan implementation.
- **Round 2 (`1642021`)**: manual-smoke fixes — NaN camera poison; container wipe; zoom-clamp floors.
- **Round 3 (`8958d48`)**: Orphans toggle removed; layout spread; engine link-mutation fix (shallow clones + endpoint-key matching); label thresholds scaled to degree distribution.
- **Round 4 (`b85dab2`)**: link-width zoom compensation removed; tag nodes sized by absolute member count.
- **Round 5 (`cd3ce3d`)**: per-kind layout forces — tag springs (55/strength 1), page springs stock via `d3DefaultLinkStrength`, tag charge −700 + distanceMax.
- **Round 6 (`adb6785`)**: tag-expulsion bug fix (charge is scalar per node; boosted charge repelled tags from own members → periphery halo). Custom `createTagRepulsionForce` (tag↔tag-only, distance-capped, bounded coincident fallback) registered via `d3Force('tagRepulsion', fn)`; charge back to −240.
- **Round 7 (`d1d7328`)**: big tags still clumped — their many strength-1 member springs anchor them to the same centroid when member sets overlap, overpowering the uniform kick. Fix: (a) tag↔tag inverse-square scales by geometric mean of member counts (√(mA·mB); 12-member tags repel 12× harder), base 300→900; (b) soft exclusion shell sized by rendered radii (engine: √val·relSize/2, zoom-compensated ⇒ graph-space radius √val·3) + margin, spring-like push; (c) per-pair kick clamp for stability.
- Validation per round: tsc clean, UI suite green, lint, build, root fast suite, LSP clean.

## Round 8 (`2eaa3ad`, 2026-09-06) — force model rework: size-inverse tag springs, inert page links

User brief: tag→page attraction inversely proportional to tag size (smaller tags pull their pages harder); wiki links between pages exert NO force; expected outcome: the largest tag nodes drift to the graph edges and pages cluster around the tags most distinctive to them.

- **wiki-graph-utils.ts**: `d3DefaultLinkStrength` + `WIKI_LINK_DISTANCE` deleted; new exported `tagSpringStrength(memberCount) = WIKI_TAG_SPRING_STRENGTH / max(1, memberCount)`; force-model doc rewritten (tag springs are the only attraction; kick clamp kept).
- **wiki-graph.tsx**: `layoutEdgeDegreesRef` (all-edge degrees) → `tagMemberCountsRef` (per-tag member count over kind:'tag' edges only); strength accessor: tag edge → `tagSpringStrength(count of that tag's member edges, resolved via edgeEndpointId for engine-mutated links)`, link edge → 0; distance accessor constant `WIKI_TAG_LINK_DISTANCE` (inert for page links since their strength is 0). Charge and tagRepulsion untouched.
- **Mechanics**: per-edge strength × member count ≈ constant ⇒ net tag pull is size-stable; big tags anchor weakly per member and drift outward under the geometric-mean-scaled tag↔tag repulsion; pages settle toward their distinctive small tags.
- **Tests**: `tagSpringStrength` describe (base at ≤1 member, 1/n division, small>big, decay); component force assertions rewritten (page strength 0, tag strength base then base/2 via rerender adding a second member, charge −480, distance 55 for both kinds); fixed 2 PRE-EXISTING constants-drift failures (tests still asserted pre-tuning shell clamp 25 and link distance 90; shell assert now symbolic `±WIKI_TAG_MAX_KICK`).
- **Knobs now**: `WIKI_CHARGE_STRENGTH` −480 · `WIKI_TAG_LINK_DISTANCE` 55 · `WIKI_TAG_SPRING_STRENGTH` 0.1 (tuned in the OLD regime with stiff page springs — live-tune expected; now divided by member count per edge) · `WIKI_TAG_REPULSION_STRENGTH` 1800 · `WIKI_TAG_REPULSION_DISTANCE_MAX` 12000 · `WIKI_TAG_MIN_SEPARATION_SCALE` 12 · `WIKI_TAG_SEPARATION_STRENGTH` 90 · `WIKI_TAG_MAX_KICK` 50 · `NODE_SIZE_SPREAD` 2 · `LABEL_THRESHOLD_*` unchanged. `WIKI_LINK_DISTANCE` removed.
- **Validation**: graph tests 52/52, UI suite 130/130, tsc --noEmit clean, eslint+prettier clean, UI build ok, LSP clean on all touched files, repo-wide grep zero stale references to the deleted exports.

## Round 9 (`1152d52`, 2026-09-06) — visual tweaks + broken-link attraction + zoom-clamp sizing fix

User brief: tag fill less transparent; page-page links slightly translucent; broken links pull hard. Mid-round diagnostic: "page nodes lost dynamic sizing; sizes are there but subtle, and they don't recalculate on zoom anymore even though tag nodes do."

- **TAG_FILL_LIGHT/DARK** alpha 0.08 → 0.18 (TAG_DIM focus-dim unchanged).
- **LINK_COLOR_LIGHT/DARK** alpha 0.4/0.7 → 0.3/0.6 (2 test asserts updated).
- **Broken links pull hard**: new knob `WIKI_BROKEN_LINK_SPRING_STRENGTH = 0.6` in wiki-graph-utils; component strength accessor: tag → `tagSpringStrength`, broken link (existing `isBrokenLink`, engine-form-safe) → knob, else 0.
- **SIZING on zoom — root cause found, NOT the sizing pipeline**: zoom compensation computes `relSize = BASE(6)/k` but clamps to `MIN 0.35 / MAX 20`. Round-8 layouts auto-fit at k ≈ 0.05–0.1, so `6/k` pins at MAX 20 — page circles freeze (engine-rendered) across the whole low-zoom band while tag rings/labels look alive (custom canvas path + `/globalScale` stroke). Raised clamp to MIN 0.5 / MAX 150, which covers the full `MIN_ZOOM_K 0.05 → MAX_ZOOM_K 10` range (needs [0.6, 120]). Added low-zoom regression assert (k=0.1 → relSize 60). Sizing pipeline (`applyNodeSizing` blend, wiki.tsx memo, nodeValAccessor, graphData push) verified intact first; `2d18d52` touched only force constants.
- **Validation**: graph tests 52/52, UI suite 130/130, tsc clean, lint clean, build ok, LSP clean.

### Knobs after Round 9

`WIKI_CHARGE_STRENGTH` −480 · `WIKI_TAG_LINK_DISTANCE` 55 · `WIKI_TAG_SPRING_STRENGTH` 0.1 · `WIKI_BROKEN_LINK_SPRING_STRENGTH` 0.6 · `WIKI_TAG_REPULSION_STRENGTH` 1800 · `WIKI_TAG_REPULSION_DISTANCE_MAX` 12000 · `WIKI_TAG_MIN_SEPARATION_SCALE` 12 · `WIKI_TAG_SEPARATION_STRENGTH` 90 · `WIKI_TAG_MAX_KICK` 50 · `NODE_SIZE_SPREAD` 2 · `MIN_NODE_REL_SIZE` 0.5 / `MAX_NODE_REL_SIZE` 150 (was 0.35/20) · `TAG_FILL` alpha 0.18 · `LINK_COLOR` alpha 0.3/0.6.

## Round 10 (`e3423f2`, 2026-09-06) — page-link attraction restored with unique-destination falloff

User brief: bring back some attraction on page-page links, falling off quickly as the total number of UNIQUE LINK DESTINATIONS among both pages increases (user refined from "total links" mid-brief) — a page linking to almost everything exerts nearly no force; a small cluster linking each other keeps some attraction.

- **wiki-graph-utils**: `WIKI_PAGE_LINK_SPRING_STRENGTH = 0.3` · `WIKI_PAGE_LINK_DISTANCE = 180` (restored from the R8 removal — needed again now that page springs return) · `pageLinkSpringStrength(sourceTargets, targetTargets) = base / max(1, |union|)` over ReadonlySets of destination ids.
- **wiki-graph.tsx**: new `linkTargetsRef` (per-page Set of unique wiki-link destinations, direction-agnostic, built over kind:'link' edges with `edgeEndpointId` resolution); strength else-branch → `pageLinkSpringStrength(...)`; distance accessor: tag|broken → 55, normal page link → 180. Broken links KEEP fixed 0.6 (R9 rule).
- **Semantics**: union-of-destinations is dominated by the BUSIEST endpoint — the opposite of d3's `1/min-degree` default, which stiffens leaf links. The link edge itself guarantees union ≥ 2, so base/2 is the max page-link strength; shared destinations count once (duplicate links don't inflate).
- **Tests**: `pageLinkSpringStrength` describe (isolated pair base/2, triangle base/3, shared-destinations-once base/4, 40-destination hub < 0.01); component asserts edges[0] base/3 (a→{b,missing}, b→{a}), edges[2] base/2 (d↔e), distance split 180/55, broken still 0.6.
- **Validation**: graph tests 56/56, UI suite 134/134, tsc clean, lint clean, build ok, LSP clean.

### Knobs after Round 10

`WIKI_CHARGE_STRENGTH` −480 · `WIKI_TAG_LINK_DISTANCE` 55 · `WIKI_PAGE_LINK_DISTANCE` 180 · `WIKI_TAG_SPRING_STRENGTH` 0.1 · `WIKI_BROKEN_LINK_SPRING_STRENGTH` 0.6 · `WIKI_PAGE_LINK_SPRING_STRENGTH` 0.3 · `WIKI_TAG_REPULSION_STRENGTH` 1800 · `WIKI_TAG_REPULSION_DISTANCE_MAX` 12000 · `WIKI_TAG_MIN_SEPARATION_SCALE` 12 · `WIKI_TAG_SEPARATION_STRENGTH` 90 · `WIKI_TAG_MAX_KICK` 50 · `NODE_SIZE_SPREAD` 2 · `MIN_NODE_REL_SIZE` 0.5 / `MAX_NODE_REL_SIZE` 150 · `TAG_FILL` alpha 0.18 · `LINK_COLOR` alpha 0.3/0.6.

## Round 11 (`13e6fa4`, 2026-09-06) — page-over-tag layering + page outlines

User brief: pages always layer above tags (visually AND for click reception); page nodes get outlines in the link-edge color.

- **Layering**: force-graph draw order = graphData array order (last drawn on top) and hit-testing picks the topmost drawn node, so ONE mechanism fixes both. Data push now stable-sorts a copy pages-last (`orderedNodes`); prop array stays unmutated for the page memo. Previously `buildAugmentedWikiGraph` emitted pages-first/tags-last, i.e. tags sat on top.
- **Outlines**: page branch in `nodeCanvasObjectAccessor` strokes the node circle — `theme.linkColor` (unlit link-edge color, theme-aware) for existing pages, `PLACEHOLDER_AMBER` for missing, `theme.dimLink` while focus-dimmed; width 1.5/globalScale like the tag ring. Fill accessors untouched (fills stay PAGE_BLUE/amber).
- **Tests**: tag-first fixture asserts pages-last ordering in pushed data + prop not mutated; fake-canvas asserts page = exactly 1 stroke in `rgba(148, 163, 184, 0.3)`, missing page outlines amber, tag ring never uses page-outline color; shape test rewritten content-level (pushed nodes kind-sorted, links = canonical clones) since array order changed by design.
- **Validation**: graph tests 23/23, UI suite 136/136, tsc clean, lint clean, build ok, LSP clean.

## Round 11b (`ddc8e44`, 2026-09-06) — outline visibility fix

User report: layering fix worked, outlines not visible. Root cause: the outline borrowed `theme.linkColor`, whose 0.3 alpha was tuned DOWN in Round 9 for receding hairline edges — correct hue, invisible as a 1.5px ring (tag rings read because they are solid hex). Fix: dedicated `PAGE_OUTLINE_LIGHT/DARK` constants at 0.8 alpha in the same slate family (`rgba(100,116,139,.8)` light / `rgba(148,163,184,.8)` dark), wired through the theme object as `theme.pageOutline`. Missing-page amber + dim behavior unchanged. Lesson: reusing a color tuned for one stroke width/context at another is a visibility bug class — when the user says "same color as X" for a STROKE, check X's alpha first.

## Notes / lessons

- **many-body charge is scalar per node** — cannot repel a group from itself only; use a custom force via `d3Force(name, fn)`. Contract: `(alpha) => void` mutating vx/vy, `initialize(nodes)` re-run on graphData push.
- **Springs vs repulsion balance**: with size-inverse springs, per-edge strength × member count ≈ constant, so net tag pull no longer scales with member COUNT — the geometric-mean weighting on tag↔tag repulsion now dominates big-tag placement on its own.
- **Clamp kicks** when stacking strong force terms — inverse-square × size-scaling × shell can launch nodes.
- **d3 accessor outputs are unary-plussed** — undefined = NaN. Reproduce stock defaults in fallback branches.
- **force-graph mutates edge objects passed to graphData** — shallow clones + endpoint-key matching.
- **LINKS screen-space / NODES graph-space** in force-graph rendering — only compensate nodes on zoom.
- **Camera calls guard on finite positions**; engine constructor wipes mount element; LSP stale across file__write; `tsc --noEmit` is ground truth.
- **Manual smoke is not optional**: rounds 2, 3, 4, 6, 7 all originated from user observation/screenshot at the real canvas.
- **apply_diff reliability**: ADD-only hunks create duplicates (happened twice this session); on any suspicion, grep for duplicated blocks and read the full region before continuing. Round 8: a multi-hunk patch ALSO reported hunk success/failure incorrectly (one hunk reported failed but applied, another reported applied but not) — verify actual file state with grep/read after every multi-hunk patch, regardless of the report.
- **Test assertions on tuned constants should be symbolic** (`expect(x).toBe(-WIKI_TAG_MAX_KICK)`, `toBeCloseTo(WIKI_TAG_SPRING_STRENGTH / 2)`), never literal numbers — post-commit live-tuning of exported constants had left 2 tests red on `main`-adjacent state.
