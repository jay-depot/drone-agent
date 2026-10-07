---
tags: [decision, drone-coordinator-ui, wiki, graph, force-graph, animation, layout]
related: [modules/drone-coordinator-ui.md, decisions/194-wiki-graph-view.md, decisions/193-wiki-pitch-field.md]
---

# 195: Wiki graph visual polish — sizing, labels, forces, showdown, live updates

**Status**: Implemented (2026-09-06, branch `feat/memory-wiki-browser-improvements`, 27 rounds across commits `de9bdef`..`0bf60d5`, from plan `plan-swarm-wiki-graph-visual-polish` + user-directed rounds)

## Context

[194-wiki-graph-view](194-wiki-graph-view.md) shipped a working force graph, but exploration
quality needed a lot of tuning: labels were all-or-nothing, node sizes didn't
encode importance, the layout didn't organize by topic, focus was a filter not
a spotlight, and live updates blinked nodes into existence. This ADR records
the final state of the graph rendering system after 27 user-directed rounds;
the intermediate history lives in project memory (plan rounds 1–27).

## Decision — final semantics

**Tag nodes organize the layout.** `buildAugmentedWikiGraph` derives one tag
node per unique tag (`tag:<tag>` id) plus `kind: 'tag'` edges; tag nodes are
hollow-ish translucent green discs sized by member count, layout-active even
when the Tags toggle hides them (shrunk to 5% via `nodeVal`), clickable to
focus.

**Force model** (`lib/wiki-graph-utils.ts`, all knobs exported for live tuning):
- **Tag springs are the only structural attraction**:
  `tagSpringStrength(memberCount) = WIKI_TAG_SPRING_STRENGTH (0.1) / max(1, memberCount)`
  at `WIKI_TAG_LINK_DISTANCE = 55` — small distinctive tags bind their pages
  tightly; big tags pull each member weakly (net tag pull ≈ constant) and drift
  outward.
- **Page↔page links pull gently with linkedness falloff**:
  `pageLinkSpringStrength(sourceTargets, targetTargets) = 0.3 / |union of both pages' unique link destinations|`
  at `WIKI_PAGE_LINK_DISTANCE = 180` — a hub linked everywhere exerts ~no
  force; a small mutually-linked cluster stays cohesive (deliberate inverse of
  d3's `1/min-degree` default). Union counts shared destinations once; every
  real edge contributes both endpoints, so base/2 is the max.
- **Broken links pull hard**: `brokenLinkSpringStrength(deadLinkCount) = 0.6 / max(1, dead links on the source page)`
  at the tight 55 distance — a lone dead link hugs its parent; a page riddled
  with dead links lets them clump loosely.
- **Uniform charge** `WIKI_CHARGE_STRENGTH = -480`.
- **Tag↔tag repulsion** via a custom force registered with
  `d3Force('tagRepulsion', fn)` (`createTagRepulsionForce`,
  `WIKI_TAG_REPULSION_STRENGTH = 2400`): many-body charge is scalar per node
  and cannot repel a group from itself; this force is tag↔tag-only,
  distance-capped, with a soft exclusion shell sized by rendered radii
  (engine radius = `√val × nodeRelSize`, no ÷2) and a geometric-mean size
  factor (√(mA·mB)) so big tags separate harder. Per-pair kicks clamped at
  `WIKI_TAG_MAX_KICK = 50`.

**Node sizing**: `_val = (0.231 + 2.77 · importance)^1.5` where importance is
`0.7·normalized wiki-link degree + 0.3·log-normalized wordCount` (smallest
pages render at exactly 1/3 of the old minimum radius; max-importance pages
unchanged — 3× the contrast). Tag `_val` = member count.

**Paint order** (finalized): tag edges → tag nodes → page link edges → tag
labels → page nodes → page node labels. The engine paints all links before all
nodes in array order, so `toEngineLinks` stable-sorts tag edges first and the
node push sorts pages last. Arrowheads removed entirely.

**Labels paint in `onRenderFramePost`** — the engine hook that runs after the
whole scene — so no later-painted node disc can bury an earlier label. Label
legibility: blurred scrim (`ctx.filter = 'blur(2px)'`, probed — Safari
degrades to a shadow-spread band) behind page labels in a theme-aware scrim
(`rgba(15,23,42,.55)` light / `rgba(0,0,0,.72)` dark), plus a tight dark glyph
shadow on all labels. Tag labels render centered inside their discs in
tag-green (`#15803d`/`#4ade80`), no scrim band.

**Showdown label culling** (`lib/label-showdown.ts`,
`selectShowdownSurvivors`): zoom-tier thresholds were removed (Showdown is the
sole label selector — remote clusters label when they fit). Every positioned
node is a candidate scored by `_val` (identical to node size, so display
priority and visual weight never drift). Candidates rank best-first (ties:
ascending id, deterministic); a label survives iff it intersects no
higher-ranked candidate's rectangle — culled rects still exclude (strict
local-maxima, no chain rescue). Pages and tags run as **two independent
showdowns** (cross-kind overlap allowed). Survivor sets recompute on data
push, zoom, engine ticks (throttled 100ms), and **focus changes** (the focus
effect must recompute — the candidate pool changes with dimming), plus a final
recompute on engine stop. Screen-space rects: tags centered in the disc, pages
in the below-node text+scrim box; measured with an offscreen canvas
(`length × fontSize × 0.6` fallback where 2D context is unavailable).

**Focus mode**: dim-and-spotlight (dimmed nodes/edges render in dim colors and
are skipped by the label pass) + a floating, content-hugging left panel
(`absolute` overlay with `shadow-lg`, independent of graph layout; page panels
show pitch + tags, tag panels show only the member count — members are
highlighted on the canvas) + a neighborhood-fit camera (focus + 1-hop
neighbors fit the viewport via `fitScale` from the container's real pixel
size) + focus-aware tag visibility (Tags toggle off wins; a focused page keeps
only its connected tags; a focused tag hides all other tags — one
`isTagNodeVisible` rule consulted by every tag-rendering and hit-test path).
The focused node's label **always draws**, bypassing Showdown.

**Zoom-to-fit toggle** (⤢, `aria-pressed`, on by default): while on, the
camera refits on engine stop and data pushes; manual zoom (buttons, or wheel —
captured on the component root in the capture phase so it disarms *before* the
engine's d3-zoom handler) disarms it; re-arming fits immediately. Focus
camera wins over reactive fit while a node is focused.

**Sizing on zoom**: node circles are zoom-compensated (`nodeRelSize = 6/k`,
clamped 0.5–150 — the clamp must cover the full `MIN_ZOOM_K 0.05`–
`MAX_ZOOM_K 10` range; a narrower clamp freezes node sizes across the deep
zoom-out band). Links are engine-screen-space and need no compensation.

**Live-update animation** (consumers of the `wiki.changed`-driven refetch):
the data push diffs ids against the previous push (snapshot taken *before*
`nodesRef` is overwritten) and:
- *Added* nodes get a random landing spot inside the visible graph-space rect
  with zero velocity, then are "held" — engine-tick damping at ~3% ramping to
  full over `DRIFT_MS = 2000` (the let-go), radius easing in 30%→100%. When
  the last drift ends: settling flag clears and one deferred zoom-to-fit runs.
- *Removed* nodes become ghosts for `FADE_MS = 600`: they stay in the pushed
  scene, shrink via `nodeVal`, render dimmed, are skipped by the label pass,
  and are excluded from tag repulsion (`setExcluded`) so invisible nodes can't
  push real ones.

## Key engine facts (force-graph 1.51.4, verified in-bundle)

- **Every prop goes through `accessorFn`** — a *string* prop is a per-item
  property-name lookup, not a constant. `nodeCanvasObjectMode('after')`
  silently evaluates `node['after']` (undefined) and disables all custom node
  painting; it must be `() => 'after'`.
- Engine node radius is `√val × nodeRelSize` with **no ÷2**.
- `onRenderFramePre/Post(ctx, globalScale)` run outside the scene paint —
  anything that must layer above everything (labels) belongs there.
- Links paint before nodes, in array order; nodes in array order; the shared
  arrow pass paints after everything (why arrows were dropped rather than
  layered).
- The engine re-heats to alpha 1 on every `graphData` push; d3 initializes
  position-less nodes on an origin spiral — hence explicit landing spots.
- jsdom cannot render the canvas: page tests stub the component, the wrapper
  is tested via the injectable `forceGraphFactory`, and landing-spot tests
  must stub `getBoundingClientRect` to a sized rect.

## Tests

31 component tests + 35 util tests + 7 showdown units, including: force
accessors per kind (with engine-mutated endpoints), tag-spring inverse
scaling, ghost exclusion, landing-spot assignment (sized container stub),
showdown gates (duel, no-chain-rescue, tie determinism both input orders,
edge-touching non-overlap), focus override, low-zoom compensation, zoom-to-fit
toggle semantics (default-on, disarm via buttons/wheel, re-arm immediate fit),
paint-order (nodes pages-last, links tag-first, clones not canonical), label
passes (frame-post accessors, color/geometry per kind), and theme flips.

## Related

- [194-wiki-graph-view](194-wiki-graph-view.md) — the base graph this polishes
- [193-wiki-pitch-field](193-wiki-pitch-field.md) — pitch shown in panels
- [drone-coordinator-ui](../../drone-coordinator-ui/) — the component/hook/util inventory
