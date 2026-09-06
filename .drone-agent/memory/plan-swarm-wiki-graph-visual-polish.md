---
key: plan-swarm-wiki-graph-visual-polish
tags:
  - plan
  - drone-coordinator-ui
  - wiki-graph
created: 2026-09-06T00:26:00.119Z
updated: 2026-09-06T00:26:00.119Z
---

# Plan: Wiki graph view — visual polish (v2)

## Summary

Improve the visual legibility and exploration value of the coordinator wiki graph view (`/wiki?view=graph`, built in plan-swarm-wiki-graph-view, completed 2026-09-04). Today the graph renders anonymous same-size dots, no labels, no initial zoom fit, orphans scattered to the periphery, and a focus mode that barely changes pixels. This plan makes the graph exploration-first: named nodes with zoom-tiered labels, size encoding importance, tag nodes that organize layout, a real dim-and-spotlight focus, zoom-compensated node/link sizing, and on-canvas chrome (legend, zoom controls, toggles).

User decisions locked during grilling (all confirmed):

1. **Exploration-first**; maintenance signals stay one toggle away.
2. **Zoom compensation**: node/link size re-pushed on `onZoom` so nodes keep a near-constant screen size when zoomed out (currently a one-shot global `nodeRelSize`).
3. **Orphans visible by default**, docked near their topical neighborhoods via tag-node attraction; toggle (URL-persisted when off) hides them + re-fits view.
4. **Tag nodes as the only attraction mechanism** (supersedes any page↔page overlap-edge idea): pages tether to tag nodes; when tags are hidden the tag layer stays in layout (invisible, still attracting). Tag nodes: **hollow rings, nice green** (e.g. `#22c55e` dark / `#16a34a` light), always labeled when visible, clickable-to-focus.
5. **Labels**: `labelVisible = degree ≥ threshold(zoom)`; threshold drops as zoom increases (mega-hubs named when zoomed out; everything named zoomed in). Hover tooltip universal. Tag labels always shown when tags visible. Degree counts **wiki-link edges only** (tag edges excluded from degree math everywhere).
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

## Step 1 — `wordCount` in `buildGraph()` (server)

`drone-swarm-common/src/wiki-storage.ts`:

- Add `wordCount: number` to `WikiGraphNode`.
- In `buildGraph()`, compute per page: `content.split(/\s+/).filter(Boolean).length` (content already in hand for link extraction — free).
- Broken-link placeholder nodes: `wordCount: 0`.
- Tests (`drone-swarm-common/test/wiki-storage.test.ts`): wordCount present on real nodes; 0 on placeholders; whitespace-heavy content counted correctly.

**After this step run `pnpm -r run build` before UI work** — the UI resolves drone-swarm-common types from built dist/, so stale diagnostics otherwise.

## Step 2 — UI types

`drone-coordinator-ui/src/lib/types.ts`:

- Add `wordCount: number` to `WikiGraphNode` (mirror server).
- Add UI-local augmented types:

```ts
export type GraphNodeKind = 'page' | 'tag';
export type AugmentedGraphNode = WikiGraphNode & { kind: GraphNodeKind };
export type AugmentedGraphEdge = Omit<WikiGraphEdge, 'kind'> & {
  kind: 'link' | 'tag';
};
```

Server `kind` stays `'link'`-only; tag edges are client-derived.

## Step 3 — Pure shaping utilities (rework `wiki-graph-utils.ts`)

Replace `buildFocusedSubgraph` (delete it and its tests — dead code rule) with:

- `wikiLinkDegrees(edges: AugmentedGraphEdge[]): Map<string, number>` — count in+out over `kind:'link'` edges only.
- `buildAugmentedWikiGraph(graph: WikiGraph): { nodes, edges }` — one tag node per unique tag across visible pages (`id: 'tag:'+tag`, `kind:'tag'`, `title: tag`, `tags:[tag]`, `exists:true`, `wordCount:0`), one `kind:'tag'` edge per page→tag. Dedup. Tag nodes with zero member edges never occur pre-filter.
- `filterOrphans(g): g` — drop `kind:'page'` nodes with wikiLinkDegree 0, their edges, then drop tag nodes left with no edges.
- `applyNodeSizing(nodes, edges)` — computes the blend formula above and returns nodes with `val` (store as `_val` on the node objects for the `nodeVal` accessor).
- `labelDegreeThreshold(k: number): number` — `k<=0.75 → 10`, `k>=2.5 → 0`, linear between; clamp. Export constants.
- `buildFocusSets(edges: AugmentedGraphEdge[], focusedId: string)` — `{ neighborIds: Set, touchingEdgeSet: Set }` (tag edges included when the focus is a tag node).

Unit tests for every function, including: degree excludes tag edges; blend normalization edge cases (all-zero graph, single node); threshold interpolation endpoints; orphan filter removes emptied tag nodes; focus sets for page-focus and tag-focus.

## Step 4 — Component rework (`wiki-graph.tsx`)

Extend `ForceGraphHandle` with what's needed: `nodeVal`, `nodeCanvasObject`, `nodeCanvasObjectMode`, `nodeLabel`, `onZoom`, `zoom`, `centerAt`, `zoomIn`, `zoomOut`, `linkLineDash`, `onEngineStop`, `cooldownTicks` (verify exact names against force-graph v1.51 docs during implementation).

New props: `tagsVisible: boolean` (orphans/toggle filtering is done by the page before props arrive). Keep `forceGraphFactory` injectable seam.

State flows through refs read by accessors (accessors are closures the engine calls per frame — props/state must reach them via `useRef` mirrors, following the existing `cbRef`/`linkColorRef` pattern):

- `zoomRef` (from `onZoom`) — drives `nodeRelSize = clamp(BASE/k, 3, 12)` and `linkWidth = clamp(BASE_LW/k, 0.5, 4)` re-push, plus label threshold checks in `nodeCanvasObject`. Zoom triggers canvas redraw, so ref-reading accessors restyle next frame with no extra render plumbing.
- `focusRef` (from `focusedNodeId` prop + `buildFocusSets` memo) — dim-and-spotlight in `nodeColor`/`linkColor`: dimmed page `rgba(37,99,235,0.15)`, dimmed link near-transparent; touching links brightened + `linkWidth` up via a link-width accessor; focused node ring drawn in `nodeCanvasObject` (stroke arc, green if tag).
- `tagsVisibleRef` — `kind:'tag'` nodes when hidden: transparent color, no label, tiny val (force intact); clicks on them ignored; their edges transparent + width 0. When visible: green hollow ring (stroke, no fill) + always-on label + normal click-to-focus.
- Broken-link edges (target node `exists:false`): amber `'rgba(217,119,6,0.5)'` + dashed via `linkLineDash([4,3])` accessor.
- Labels (`nodeCanvasObject`, drawn after node shape): page labels when `wikiLinkDegree >= labelDegreeThreshold(zoomRef.k)` and node visible and not focus-dimmed; tag labels always when tags visible. Font size scales with `globalScale`; text drawn with a subtle dark backing or shadow for contrast.
- Tooltips: `nodeLabel` accessor — page title / tag name / `Missing page: <id>` for placeholders.
- Camera: on `focusedNodeId` change → `centerAt(node.x, node.y, 600)` + `zoom(max(k,1.6), 600)`. On clear/reset → `zoomToFit(600, 40)`. Auto-fit: `onEngineStop` → `zoomToFit(600, 40)` once per data change (flag reset in the data-push effect when node count changes, e.g. orphan toggle).
- Data-push effect: `fg.graphData(...)` then re-apply size + zoom compensation with current k.
- Chrome (JSX overlay inside the relative container): legend bottom-left (styled spans), zoom controls top-right (+ / − / reset) calling handle methods; both `pointer-events-auto`, canvas container `relative`.

Tests (`wiki-graph.test.tsx`, fake handle): new accessors wired; zoom callback updates nodeRelSize/linkWidth; dim colors applied when focused via captured accessors invoked with fake nodes/edges; tag-hidden accessors transparent + click ignored; broken-link dash/amber; legend and zoom buttons render and invoke handle; destructor unchanged.

## Step 5 — Page wiring (`pages/wiki.tsx`)

- URL state: keep `view`/`node`; add `orphans` (persist `orphans=0` when hidden; default visible) and `tags` (persist `tags=1` when visible; default hidden). Both via `setSearchParams` like existing params.
- Shape before render: `const augmented = useMemo(() => graph ? buildAugmentedWikiGraph(graph) : null, [graph])`; `const visible = orphansVisible ? augmented : filterOrphans(augmented)`.
- Remove the `buildFocusedSubgraph` swap — pass full `visible` nodes/edges; keep `focusedNode` lookup for the preview panel; panel becomes kind-aware: tag nodes show tag name + member-page count, and no "Open full page" button.
- Header: two small toggle buttons next to Grid/Graph — "Tags" and "Orphans" (variant reflects state; titles explain: tags organize the layout even when hidden).
- Tests (`wiki.test.tsx`): toggles render and persist URL params; orphan-off triggers filter path (stubbed component receives fewer nodes); tag-on passes tagsVisible; preview panel for a tag focus renders without "Open full page"; existing grid/fetch tests unchanged.

## Step 6 — Validation (final step; check every item)

1. `pnpm -r run build` — passes (also required mid-plan after Step 1).
2. `pnpm lint` (eslint + prettier) — zero errors. Re-read prettier-touched files before any further edit.
3. Root fast suite `pnpm test` — passes incl. new drone-swarm-common tests.
4. UI suite `cd drone-coordinator-ui && NODE_ENV=test npx vitest run` — passes incl. new util/component/page tests.
5. LSP diagnostics clean on all touched files (`lsp__get_diagnostics` per file; run after the rebuild in Step 1 so dependent types are fresh).
6. Manual smoke: run coordinator + UI dev servers; on `/wiki?view=graph` verify — auto-fit on load, zoom out keeps node screen-size + mega-hub labels, zoom in reveals more labels, tags toggle shows green hollow rings that still organize layout when hidden, orphans docked near their tag clusters and hide/refit on toggle, click = dim-and-spotlight with camera move, tag click focuses members, broken links dashed amber, legend/zoom controls work in both themes.

## Validation criteria checklist

- [ ] `buildGraph()` nodes carry `wordCount` (0 for placeholders); drone-swarm-common tests pass; `pnpm -r run build` before UI work.
- [ ] `buildFocusedSubgraph` deleted; utils reworked with degree/sizing/augmentation/filter/threshold/focus-sets, all unit-tested.
- [ ] Zoom-compensated node/link sizing live via `onZoom`; labels zoom-tiered by wiki-link degree; hover tooltips present.
- [ ] Tag nodes: green hollow rings, labeled when visible, clickable-to-focus, layout-attracting when hidden; no page↔page overlap edges anywhere.
- [ ] Orphans visible by default, docked via tag attraction; toggle hides + re-fits; URL persistence for non-defaults (`orphans=0`, `tags=1`).
- [ ] Focus = dim-and-spotlight + camera move; preview panel kind-aware (tag focus has no "Open full page").
- [ ] Legend + zoom-in/out/reset overlay; dashed amber broken-link edges; both themes handled.
- [ ] All Step-6 validation gates pass (build, lint, fast suite, UI suite, LSP clean, manual smoke).
