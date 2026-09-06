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

## Round 12 (`8c17e0d`, 2026-09-06) — custom node painting was DEAD since Round 1; fixed

User report: outlines still invisible; and the reveal — tag rings NEVER rendered either (user preferred the translucent-solid look anyway). That invalidated the "tag rings prove the callback works" premise from Rounds 11/11b.

- **Root cause (probe-proven)**: force-graph wraps every prop in `accessorFn`, which treats a STRING prop as a property NAME read per item. `nodeCanvasObjectMode('after')` evaluated `node['after']` = undefined per node, so the engine's before/after branches never matched and `nodeCanvasObject` was NEVER invoked — no tag rings, no outlines, no canvas labels, no focus rings, ever. What users saw as "rings" were the engine's native hover tooltips. Fix: `.nodeCanvasObjectMode(() => 'after')` (handle type widened to `string | fn`).
- **Second latent bug**: engine `paintNodes` (1.51.4) draws radius `sqrt(val) * nodeRelSize` with NO `/2`; our ring/outline radius assumed `* 0.5`, i.e. half the node radius, hidden inside the disc. Ring radius matched to engine; `tagRadius` in utils corrected the same way → tag-separation shell effectively doubles.
- **Tag hollow-ring stroke removed** per user preference (translucent-solid fill suits tags); TAG_RING_*/TAG_DIM constants retained (focused-node ring, legend, dim states).
- **Empirical verification method**: esbuild-bundled probe page (IIFE, file://, no server) importing the exact node_modules force-graph 1.51.4, driven by playwright-core + the already-cached ms-playwright Chromium (the MCP playwright server demanded branded Chrome at /opt/google/chrome and `playwright install chrome` hung on a sudo prompt — passwordless sudo unavailable). Probe logged callback invocations per frame + pixel-scanned the canvas for outline colors: string mode = 0 invocations; function mode = per-frame invocations, outline pixels exactly at the disc edge.
- **Validation**: tsc clean, UI 136/136, graph tests 58/58, lint, build, LSP clean.

## Round 13 (`9dbf1c8`, 2026-09-06) — steeper label falloff, distinct tag labels, tag fade parity

User (after Round 12 made labels actually render): falloff on zoom-out should be more aggressive; tag labels need visual distinction; then spotted tags had NO fade logic at all (the gate was page-only).

- **Steeper falloff**: `LABEL_THRESHOLD_MAX_ZOOM` 2.5 → 4 (fade spans MIN 0.75..MAX, so mid zooms stay selective); `LABEL_THRESHOLD_LOW_FRACTION` 0.35 → 0.45 (maxLabelThreshold floor test updated: boundary moved, `maxLabelThreshold(4)=2` is the new floor-band probe).
- **Tag fade parity**: the label gate is now kind-agnostic — pages rank by wiki-link degree, tags by member count (`node._val`) against `maxTagMembersRef` (computed in the data push over tag nodes). Both feed the same `labelDegreeThreshold(k, maxDegree)` curve, so big tags stay labeled while zoomed out and small tags fall away first.
- **Distinct tag labels**: `TAG_LABEL_LIGHT/DARK` (#15803d / #4ade80) through `theme.tagLabel`; tag labels draw in tag green, page labels stay white on the shared scrim band.
- **Validation**: tsc clean, UI 137/137, graph tests 59/59, lint, build, LSP clean.

## Round 14 (`c9112eb`, 2026-09-06) — tag labels centered inside their nodes

- Tag label textY = `positioned.y - fontSize/2` (visual center, textBaseline 'top'); the dark scrim band is tag-skipped (green text directly on the translucent green fill reads as a chip). Page labels unchanged: below the node at `y + radius + 3/k` with the scrim.
- Test: tag fillRect not called + tagY < node.y; page fillRect still exactly 1.
- Validation: tsc clean, UI 137/137, component tests 24/24, lint, build, LSP clean.

## Round 11b (`ddc8e44`, 2026-09-06) — outline visibility fix

User report: layering fix worked, outlines not visible. Root cause: the outline borrowed `theme.linkColor`, whose 0.3 alpha was tuned DOWN in Round 9 for receding hairline edges — correct hue, invisible as a 1.5px ring (tag rings read because they are solid hex). Fix: dedicated `PAGE_OUTLINE_LIGHT/DARK` constants at 0.8 alpha in the same slate family (`rgba(100,116,139,.8)` light / `rgba(148,163,184,.8)` dark), wired through the theme object as `theme.pageOutline`. Missing-page amber + dim behavior unchanged. Lesson: reusing a color tuned for one stroke width/context at another is a visibility bug class — when the user says "same color as X" for a STROKE, check X's alpha first.

## Round 15 (`c4dab90`, 2026-09-06) — "Showdown" label overlap culling

User-designed algorithm, Option B architecture (pure util + cached survivor sets consulted in the draw gate).

- **Util** `src/lib/label-showdown.ts`: `selectShowdownSurvivors(candidates {id,score,rect}) -> Set<id>`. Sort best-first (score desc; ties asc id = deterministic "first listed wins"), walk, survivor iff no overlap with ANY higher-ranked rect — culled rects still exclude (strict local-maxima, the user's literal lowest-first rule, NO chain rescue; flip is a one-liner if wanted live).
- **Score = node `_val`** (user: "same rules as their sizes") — pages 0.7deg+0.3log-words, tags member count; showdown priority can never drift from visual size.
- **Two independent showdowns** per kind (user: cross-kind overlap fine); zoom thresholds stay the candidate filter.
- **Rects**: screen-space (graph × k); tags centered (−fontSize/2..+fontSize/2), pages below-node text+scrim box. Measure: offscreen canvas at mount with the draw font; `length × fontSize × 0.6` fallback where getContext is null (jsdom).
- **Triggers**: data push, onZoom, onEngineTick (NEW handle method) throttled `SHOWDOWN_RECOMPUTE_MS=100` via a performance.now clock, final onEngineStop. Draw gate: after threshold check, `survivors.has(node.id)` per kind; no focus special case (dimmed already returned).
- **Tests**: 7 util cases (incl. tie determinism from both input orders, edge-touching non-overlap); component gate test (k=4 zoom zeroes the threshold to isolate showdown; page victim culled; tag showdown independent); throttle test via `vi.spyOn(performance,'now')` reprogramming — fake timers' `toFake:['performance']` does NOT fake performance.now reliably.
- **Validation**: tsc clean, UI 146/146 (20 files), lint, build, LSP clean.

## Round 21 (`6e88098`, 2026-09-06) — focus view cleanup: sidebar, neighborhood fit, focus-aware tags

- **Sidebar**: focused-node preview moved from the strip above the graph into a LEFT aside (`w-80`, card, `overflow-y-auto max-h-full` = independent scroll) inside a `flex flex-1 min-h-0 gap-4` row; graph flexes to remaining space and resizes via its existing getBoundingClientRect sizing.
- **Focus camera**: fits the highlighted NEIGHBORHOOD (focus + 1-hop from `buildFocusSets`) — bbox center via centerAt, scale from `fitScale(bbox, containerSizeRef, FIT_PADDING)` clamped to MIN/MAX_ZOOM_K — replacing both whole-graph fit and the extreme close-up (`zoom(max(k,1.6))`).
- **Tag visibility** (`isTagNodeVisible`, component scope, refs-only): Tags toggle OFF wins; page focused → only connected tags (neighborIds membership); tag focused → all other tags hidden. Consulted by node fill, nodeVal shrink, label tooltip, paintLabels candidates, tag-edge width AND color (hidden tag ⇒ TRANSPARENT edges), click hit-test.
- **Test note**: fake-handle chain test asserting `zoom(1.6, 600)` updated to neighborhood-fit semantics (centerAt(any,any,600) + zoom in (0,13.68)).
- **Validation**: tsc clean, UI 146/146, lint, build, LSP clean.

## Round 16 (`d317ae8`, 2026-09-06) — Showdown-only labels; reactive zoom-to-fit toggle

User: zoom-level filtering is no longer needed (symptom: remote clusters got no labels at low zoom even when 1-2 would fit); and ⤢ should be a REACTIVE toggle (on = refit continuously; off = never; manual zoom auto-disarms right before applying; ON by default).

- **Threshold filter removed**: every positioned node is a showdown candidate (ranked by `_val`, culled by overlap). Deleted LABEL_THRESHOLD_* consts, `maxLabelThreshold`/`labelDegreeThreshold`, `linkDegreesRef`/`maxLinkDegreeRef`/`maxTagMembersRef` refs, and the `wikiLinkDegrees` import — dead code per standards.
- **Zoom-to-fit toggle**: `zoomToFitOnRef` (default true) + `useState` mirror for aria-pressed/highlight. Refits on engine stop + data push while armed and no node is focused (focus camera wins); clear-focus refit only while armed. Disarm paths: zoom-in/out buttons flip first (then zoom), capture-phase `wheel` listener on the component ROOT (fires before the engine's d3-zoom listener; the inner mount div was NOT sufficient — dispatches on an ancestor never reach child listeners, found via test). Toggle button re-arm fits immediately.
- **Tests**: threshold describes deleted; tag label test asserts both tags label with no zoom gate; new tests: default-on refit (repeated stops keep fitting), button disarm → aria-pressed false → no reactive fit → re-arm fits immediately, wheel disarm, focus-clear refit suppressed while disarmed.
- **Trap**: events dispatched on the container (ancestor) do NOT trigger listeners on the inner engine mount div — capture-phase dispatch must target a root that is an ANCESTOR OF the d3-zoom element, and the listener must be registered on that same root.
- **Validation**: tsc clean, UI 142/142 (20 files), component 28/28, lint, build, LSP clean.

## Round 17 (`727d8df`, 2026-09-06) — sizing contrast, dead-link falloff, stronger tag repulsion, final paint order

- **Sizing**: `NODE_SIZE_MIN_BASE = 0.231` + `NODE_SIZE_SPREAD = 2.77` — `_val = (0.231 + 2.77·importance)^1.5`. Smallest pages render at exactly 1/3 of the old minimum radius (2px vs 6px at relSize 6); max-importance pages unchanged (13.68px). Contrast triples (radius span 2.28x → 6.84x).
- **Dead links**: `brokenLinkSpringStrength(deadLinkCount) = WIKI_BROKEN_LINK_SPRING_STRENGTH / max(1, count)`; count per SOURCE page built in the data push (`deadLinksBySourceRef`, using nodesByIdRef exists:false). Lone dead link = full hard pull; groups clump loosely.
- **Tag repulsion**: `WIKI_TAG_REPULSION_STRENGTH` 1800 → 2400.
- **Paint order finalized** (tag edges, tag nodes, page link edges, tag labels, page nodes, page labels): engine paints ALL links before ALL nodes in array order, so `toEngineLinks` stable-sorts tag edges first + existing pages-last node sort = the full order. Tag edges lost directional arrows (shared arrow pass paints after everything → would violate; membership arrows were noise). `linkDirectionalArrowColor` accessor removed; arrow length now a kind-aware accessor.
- **Validation**: tsc clean, UI 146/146, graph suites 68/68, lint, build, LSP clean.

## Round 18 (`84aef7b`, 2026-09-06) — labels paint in onRenderFramePost

User: page node labels still inconsistently layered (everything else much nicer). Root cause: the per-node canvas callback drew each label immediately after its own node's fill — the node loop then painted later OVERLAPPING discs on top, burying earlier labels. Same mechanism could bury tag labels under any later page.

- **Fix**: engine exposes `onRenderFramePost(ctx, globalScale)` (verified in the 1.51.4 bundle: runs after tickFrame paints the whole scene). Label painting extracted into a refs-only `paintLabels` loop registered there; node callback keeps outline + focus ring only. Same gates (dimmed continue, hidden tags continue, showdown survivors); paintLabels computes its own radius.
- **Result**: the Round-17 order is now unconditional — labels are ALWAYS the topmost layer, immune to node overlap by construction.
- **Tests**: fake handle gained onRenderFramePost (and lost stale linkDirectionalArrowColor); label/gating/throttle tests assert via the frame pass with title-based lookups ('Page', '#t') instead of per-node invocation.
- **Validation**: tsc clean, UI 146/146, component 29/29, lint, build, LSP clean.

## Round 22 (`198ab69`, 2026-09-06) — live wiki graph via WS wiki.changed; dark-mode label scrims

**Live updates**: coordinator `PUT`/`DELETE /wiki/:pageId` now `publishMutationEvent({ sessionId: pageId, eventType: 'wiki.changed', payload: { pageId } })` (pubsub envelope is `{sessionId, eventType, payload}` — sessionId is the routing key). `useWikiGraph` subscribes via `useWebSocket().subscribe('wiki.changed')`, refetch debounced 500ms (bursts collapse), guarded by `active`. Zero `wiki-graph.tsx` changes — the component fully reacts to new `graph` objects (sizing → showdown → focus). Camera: refit on data push while zoom-to-fit armed = intended for surprise clusters.

- **Tests**: route test via `vi.mock('../src/ws-pubsub.js')` with relative-count asserts (mock persists across beforeEach app rebuilds); hook tests (`use-wiki-graph.test.tsx`): mock auth+ws modules, burst of 3 events → 1 fetch, real timers + `vi.waitFor` (fake timers' advanceTimersByTimeAsync deadlocks with waitFor polling); wiki.test.tsx wraps renders in `WebSocketProvider` — AuthProvider must be OUTSIDE it (WebSocketProvider consumes useAuth).
- **Dark label scrims**: `LABEL_SCRIM_LIGHT rgba(15,23,42,.55)` (unchanged) / `LABEL_SCRIM_DARK rgba(0,0,0,.72)` through `theme.labelScrim`, used by both blur and shadow-spread paths.
- **Debugging war story**: fake-Subscriber literal+cast produced `sub.ws.send is not a function` even though the object had send — resolved by vi.mock instead of fake-WebSocket construction (probes proved route+test share one module instance; src vs dist are separate singletons).
- **Validation**: coordinator tsc+tests 4/4, UI tsc+149/149 (21 files), lint, build, LSP clean.

## Round 23 (`330c8c9`, 2026-09-06) — floating focus panel; focused-label showdown override

- **Floating panel**: focus aside is `absolute left-4 top-4 bottom-4 z-20 w-80 shadow-lg` over the graph (relative row wrapper), no longer a flex sibling — graph regains full width, panel keeps size + independent scroll + drop shadow.
- **Focused label override**: paintLabels bypasses the survivor gate for `focusedIdRef.current === node.id`; dimmed nodes were already excluded from candidacy, so only highlighted labels compete and the focused node can never lose its own title. Culling unchanged for all other highlighted labels.
- **Test**: focused low-score node's label draws despite having lost the duel unfocused.
- **Validation**: tsc clean, UI 150/150 (21 files), component 30/30, lint, build, LSP clean.

## Round 24 (`1d5d92a`, 2026-09-06) — content-hugging focus panel; tag panels without member list

- Panel: `top-4` anchor only (no `bottom-4` stretch), no `overflow-y-auto` — sizes to contents. Short panels no longer tower over the canvas.
- Tag focus: member-page badge list removed (members are highlighted on canvas and click-discoverable); `memberPages` derived state + unused `AugmentedGraphNode` import deleted. Page panels keep pitch + tag badges. `memberCount` stays (the "Tag · N page(s)" line).
- Test: tag panel asserts member pages are ABSENT.
- Validation: tsc clean, UI 150/150, lint (after unused-import fix), build.

## Round 23b (`02f46d3`, 2026-09-06) — height regression fix

Converting the row wrapper to `relative flex-1` dropped its `flex`, killing the flex context the graph container's `flex-1` needs → canvas collapsed to its 480px min-height (~half viewport). Fix: `relative flex flex-1 min-h-0`. Lesson: absolute-positioned overlays need the parent only to be `relative` — do not remove layout classes from the positioning context when converting a flex sibling to an overlay.

## Round 20 (`5efec74`, 2026-09-06) — reading-friendly label backgrounds

User: labels need blur (or failing that, dark spread shadows) to stay legible over tag labels and link lines.

- **Blurred scrim**: page label bands paint via `ctx.filter = 'blur(2px)'` where supported; `SUPPORTS_CANVAS_FILTER` probed once at module load (Safari's long-missing filter API falls back to a shadow-spread band: shadowColor 0.9 alpha + 3px/zoom blur around the same rect). Scrim pad widened 2→3px.
- **Glyph shadow**: ALL labels (both kinds) draw with `shadowColor rgba(0,0,0,0.85)` + 2px/zoom blur — essential for the scrim-less green tag text.
- **State hygiene**: every shadow/filter paint wrapped in save/restore so state never leaks into other ops.
- **Validation**: tsc clean, UI 146/146, component 29/29 (fake ctxs gained save/restore), lint, build, LSP clean.

## Round 19 (`cdf9bcf`, 2026-09-06) — graph view fills available vertical space

User: blank bit underneath the graph. Cause: container hardcoded `h-[calc(100vh-220px)]` — a magic guess at header/toolbar height that never matches the real chrome. Fix: page root becomes `flex h-full min-h-0 flex-col` in graph view (header `shrink-0`), container `flex-1 min-h-[480px]`; the engine already sizes from getBoundingClientRect on mount/resize, so the canvas tracks the corrected box. Grid view unchanged (natural scroll). No test changes — layout-only, covered by tsc/build; visual check on the real page pending user confirmation.

## Round 25 (`9528b07`, 2026-09-06) — no arrowheads anywhere

`linkDirectionalArrowLength` accessor call + handle method removed (tag edges already had 0 since Round 17's layering rule; page-link arrows were visual noise). Fake handle list pruned to match.

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
