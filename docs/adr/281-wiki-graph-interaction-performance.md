---
tags:
  [
    decision,
    drone-coordinator-ui,
    wiki,
    graph,
    force-graph,
    performance,
    animation,
    focus,
  ]
related:
  [
    modules/drone-coordinator-ui.md,
    decisions/194-wiki-graph-view.md,
    decisions/195-wiki-graph-visual-polish.md,
    decisions/216-coordinator-ui-wiki-table-and-filters.md,
    decisions/279-wikilinks-not-links-in-code.md,
  ]
---

# 281: Wiki graph view — bounded rendering, trickled reveals, and a single focus camera

**Status**: Implemented (2026-11-23, branch `feat/graph-view-improvements`, ~46 commits
`b04398d8`..`ec17f9b6`, 2026-11-14 → 2026-11-23)

## Context

[194-wiki-graph-view](194-wiki-graph-view.md) shipped the force graph and
[195-wiki-graph-visual-polish](195-wiki-graph-visual-polish.md) tuned its look.
Both assumed a corpus small enough to render whole. The real memory wiki is far
larger, and three problems appeared together:

- **Unbounded node count.** Every page and every tag was pushed into the engine.
  A multi-thousand-page corpus made the simulation, the per-frame paint, and the
  Showdown label pass heavy. Prior zoom-tier LOD culling and a top-500 cap were
  added, then removed, then re-added as the interaction model changed — the code
  churned because the reduction rule and the camera rule were entangled.
- **Focus transitions were abrupt.** Focusing a node replaced the graph data in
  one push; nodes blinked into existence at random viewport spots, edges popped,
  and the camera jumped.
- **No steady-state camera rule.** Focus fit the highlighted neighborhood itself
  (a private `fitScale` path) while clear-focus used the zoom-to-fit toggle; the
  two disagreed, and both fought the escape hatch that disarms auto-fit.

This branch resolves all three. It is entirely `drone-coordinator-ui` — no
beacon, coordinator, or storage change.

## Decision

**D1 — One bounded graph, computed in one pure function.**
`applySafetyCulledWikiGraph(nodes, edges, focusedId)` in `lib/wiki-graph-utils.ts`
is the single reduction step, applied after sizing. It caps the render at
`MAX_VISIBLE_PAGE_NODES = 250` pages and `MAX_VISIBLE_TAG_NODES = 750` tags.
When nothing is focused and both counts are already under the caps, it returns
the inputs unchanged (identity preserved, no work). Otherwise it:
refines candidates first (a focused page → its 1- and 2-hop link neighborhoods
plus the tags of those pages; a focused tag → its member pages plus their tags),
then keeps the top-k by `_val` (ties broken by ascending id), preserves the
focused node, prunes now-orphaned tag nodes and their edges, and drops tag nodes
with no retained member. Results are cached by node-array identity → edge-array
identity → focus key in a `WeakMap` chain, so repeated renders of the same
graph and focus return the same object.

**D2 — Reduction is layout-agnostic; the cap is the only visibility rule.**
Zoom-aware LOD filtering (hiding nodes/labels below a zoom threshold, with a
page-count-scaled radius ramp and a "top pages always visible" floor) was
**removed**. A node either survives the safety cull and is visible at every zoom
level, or it does not exist in the render. The two earlier culls that keyed
visibility off zoom were deleted, and `isTagNodeVisible` collapsed to the Tags
toggle alone (the cull result already encodes focus visibility).

**D3 — The wiki browser feeds the graph from active filters/search.**
`pages/wiki.tsx` now runs a three-stage pipeline: `sized` (`buildAugmentedWikiGraph`

- `applyNodeSizing`) → `graphSeed` (the filtered/search-constrained subset, only
  when filters or a search result are active; a focused node and a focused tag's
  members and tags are retained) → `augmented` (`applySafetyCulledWikiGraph`). So
  the graph reflects the same filter/search state as the table ([[decisions/216-coordinator-ui-wiki-table-and-filters]]),
  not just the dimming overlay. The focus preview's member count reads the
  **uncapped** tag membership from `sized`, so "Tag · N page(s)" stays truthful
  when the cull would show fewer.

**D4 — New nodes and edges are revealed in batches, not in one push.**
New nodes are queued (one page + up to three tags per cycle,
`NODE_INSERTION_MS = 100`; new edges `EDGE_INSERTION_SLOTS = 100` per cycle) and
added on timers. Every accessor (color, val, label, canvas) gates on
`insertionRevealRef`/`edgeRevealRef`, so an unrevealed node renders fully
transparent at radius 0.01 and does not appear until its cycle. A monotonic
`graphRevisionRef` invalidates pending timers on the next data push, so a focus
change aborts the previous reveal. `pendingInsertionDurationRef` records the
total so the focus transition can wait for exactly that long.

**D5 — The engine is updated through one staged, signature-deduped swap.**
`syncGraphData` builds the working node/edge set (revealed nodes plus fading
ghosts), dedupes it by a node+edge id signature, and calls `pauseAnimation()` →
`graphData()` → `resumeAnimation()` around the swap, and only reheats when the
change warrants one. Edge objects are cloned once and cached
(`workingEdgeCacheRef`). This is the only path that pushes data into the engine
after mount, so the reveal, the ghost fade, and the focus subset all share it.

**D6 — Edges have a fade lifecycle.** A removed edge fades out; a new edge fades
in (`fadingEdgesRef`, `emergingEdgesRef`, `fadingEdgeRecordsRef`), both over
`FADE_MS = 300` (shortened from 600), applied through `edgeLifecycleColor` so any
rgba color is scaled by the remaining fraction.

**D7 — Node positions survive subset pushes; new nodes land near what they
connect to.** On a focus-subset push, every node present in both the old and new
sets keeps its `x`/`y`/`vx`/`vy`, so the layout does not reheat and jump. New
nodes are placed deterministically: near the focused node when focused, else near
a connected neighbor, else at a hashed viewport point — no random blink-in.

**D8 — A hot initial layout plus a short selective heat.** The mount effect sets
`d3AlphaDecay(0.008)`, `d3VelocityDecay(0.35)`, and `warmupTicks(120)`. A custom
`createSelectiveHeatForce()` (registered as `selectiveHeat`) accelerates **only**
the nodes just revealed for the current focus neighborhood, for `FOCUS_HEAT_MS =
900`, with deterministic hash-angle impulses. The stock charge force is now an
accessor that returns 0 for unrevealed inserts, fading ghosts, and hidden tags,
so transitional nodes never push live ones.

**D9 — One camera rule: the shared zoom-to-fit owns focus too.** The private
focus-neighborhood fit (`fitScale`, a one-shot bbox zoom) was **removed**. On a
focus change the effect re-arms zoom-to-fit, centers on the focused node
(`FOCUS_CENTER_MS = 350`), reheats, and runs an interval auto-fit
(`AUTO_FIT_TICK_MS = 250`) for `pendingInsertionDuration + FADE_MS +
FOCUS_SETTLE_MS`; clearing focus reheats and the shared rule refits. `runFitTick`
is skipped while the user has disarmed auto-fit. So focus and clear-focus use the
same edge-triggered refit, and manual zoom still wins.

**D10 — Labels: truncate, cache, and rank by focus.** `graphNodeLabel` truncates
page titles to `MAX_GRAPH_PAGE_TITLE_LENGTH = 50` for Showdown and paint
(the focus preview truncates to the same 50). `measureLabelWidth` caches
`fontSize|label` widths (`LABEL_WIDTH_CACHE_MAX = 12000`). Showdown candidate
score is now focus-aware: the focused node +1000, a 1-hop neighbor +500, a
2-hop (secondary) node ×0.25, everything else −1000 — so the spotlight's labels
win space. Second-degree labels render subdued (`globalAlpha 0.55`). The
recompute bails when no visible node has a position yet, preserving the previous
survivors instead of blanking every label during a push.

**D11 — The focus panel and loading are honest.** The focus preview title
truncates to 50 chars; the graph shows a loading overlay while the fetch is
pending (`graphLoading` from `useWikiGraph`).

**Enabling changes.** `buildAugmentedWikiGraph` drops singleton tags (a tag on
one page is not a topic) and de-dupes a page's tags before deriving edges; tag
`_val` is `memberCount * 0.25` (half the former rendered radius, since engine
radius = `√val · relSize`). `buildFocusSets` gains `secondaryIds` (2-hop nodes)
and, for a focused tag, adds page↔page link edges among member pages to
`touchingEdgeKeys` so the spotlight's inter-member links light up. The
`ForceGraphHandle` structural type gains `d3AlphaDecay`/`d3VelocityDecay`/
`d3ReheatSimulation`/`pauseAnimation`/`resumeAnimation`/`warmupTicks`.

## Consequences

- The graph renders a fixed, relevant subset at every zoom, drawn from the same
  filter/search state as the table.
- Focus changes read as a sequence (center → reveal → settle → refit) instead of
  a blink, and node positions are stable across pushes.
- The reduction rule (D1/D2), the reveal rule (D4/D5), and the camera rule (D9)
  are now independent, which is what the earlier churn lacked.
- `wiki-graph.tsx` is ~1697 lines and `wiki-graph-utils.ts` ~556 lines — over the
  project's 1000-line split threshold for the component; splitting it remains a
  tracked follow-up (see `.drone-agent/memory/followup-graph-view-derived-fields.md`),
  because the file is one mount effect whose accessors close over refs.
- Still client-side: the whole graph is fetched (`GET /wiki/graph`) and reduced in
  the browser. A server-side graph/summary endpoint is the next scaling step and
  is not part of this work.

## Tests

`wiki-graph.test.tsx` grew to 53 component tests, including: the hot initial
simulation + selective heat, charge exclusion for transitional nodes, edge
fade-in/fade-out across pushes, the trickled page/tag/edge reveal with abort on
focus change, pause/resume around working-graph swaps, landing spots for added
nodes, position preservation across focus-subset pushes, the shared auto-fit
camera for focus and clear, subdued second-degree labels, focus-aware Showdown
ranking, label truncation, and label-survivor preservation while positions are
pending. `wiki-graph-utils.test.ts` covers `applySafetyCulledWikiGraph` (focus
neighborhoods, the 250/750 caps, focused-node preservation, post-focus top-k,
singleton-tag drop, result caching) and the halved tag sizing. `pages/wiki.test.tsx`
covers the filter/search-fed pipeline, the uncapped focus member count, the 50-char
preview truncation, and the loading overlay.

## Related

- [194-wiki-graph-view](194-wiki-graph-view.md) — the base graph this improves
- [195-wiki-graph-visual-polish](195-wiki-graph-visual-polish.md) — the look this refines
- [216-coordinator-ui-wiki-table-and-filters](216-coordinator-ui-wiki-table-and-filters.md) — the filter/search state the graph now consumes
- [279-wikilinks-not-links-in-code](279-wikilinks-not-links-in-code.md) — the edge source, fixed upstream
- [drone-coordinator-ui](../../drone-coordinator-ui/) — the component/util/hook inventory
