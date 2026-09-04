---
key: plan-swarm-wiki-graph-view
tags:
  []
created: 2026-09-04T23:07:35.360Z
updated: 2026-09-04T23:23:47.644Z
---

# Plan: A5 — Connected node graph view for the wiki browser

## Summary

Add an interactive, force-directed connected-node graph of the swarm memory wiki to the coordinator web UI. Pages become nodes and [[wikilinks]] become edges, letting the user visually explore how wiki pages reference each other. It is a view toggle on the existing `/wiki` list page (grid ⇄ graph), backed by a new coordinator-only graph endpoint. The graph is a maintenance/exploration aid: it surfaces orphans, broken links (missing targets), and the page-neighborhood of any node.

Context: this is A5 from `memory-wiki-browser-improvements`. The UI is `drone-coordinator-ui` (React 19, Tailwind, react-router-dom v7, testing via Vitest + @testing-library). The wiki store is `drone-swarm-common/src/wiki-storage.ts` (shared by coordinator). The existing UI list (`/wiki`) reads `GET /api/wiki` (the coordinator's store).

## Decisions locked in

1. **Endpoint is coordinator-only**: new `GET /api/wiki/graph` on the coordinator. NO beacon proxy route, NO cross-scope merge. It computes nodes+edges from the coordinator's OWN wiki store (the same pages `GET /api/wiki` returns), so the graph is self-consistent with the list view.
2. **Graph computation lives in `drone-swarm-common/src/wiki-storage.ts`** as `buildGraph()` (like `lintPages()`), reusing the existing private `extractWikiLinks` helper. No new exported helper; no graph logic in the route.
3. **Semantics**: all pages are nodes (including orphans). Edges are derived from BOTH outgoing (A links→B) and incoming (A is linked-from-by B) links, deduplicated. Broken-link targets (a [[link]] whose page doesn't exist) become placeholder nodes with `exists:false`, so missing targets are visible for maintenance. Downward-link rule is respected (no edge from a coordinator page to a beacon page — all nodes are coordinator here, so no cross-scope edges).
4. **Library**: `react-force-graph` (v1.48.2, peerDep react:* — React-19 compatible, verified via `npm view`). Isolated behind a thin wrapper component so tests exercise data-shaping/nav callbacks only, not the rendered canvas.
5. **Placement**: view toggle on `/wiki` styled like the sessions "archived" toggle — a `Button` reading `?view=graph`. `?view=graph` renders the graph; otherwise the existing card grid. One toggle switches modes with URL persistence.
6. **Interaction**: click a node → focus/expand to that node's neighborhood (its direct in/out links) in the graph; an inline preview panel shows the node's title/tags/pitch with a link to the full `/wiki/:pageId` page; a "Show all" control resets back to the full graph. Clicking empty canvas clears focus.
7. **URL state**: the focused/expanded node is persisted as `?node=<pageId>`, so browser back returns to roughly the same state (same mode + same expanded node). Mirrors how pagination offset / archived view are URL-persisted today.

## Dependencies / order

- Step 1 (coordinator `buildGraph` in drone-swarm-common) is foundational — everything downstream depends on it.
- Step 2 (coordinator route) depends on 1.
- Steps 3–5 (UI) depend on 2 (endpoint) and can proceed together.
- Install the library (Step 3) early so UI code typechecks against it.

Order: 1 → 2 → 3 → 4 → 5 → 6 (validation).

## Step 1 — `buildGraph()` in drone-swarm-common

File: `drone-swarm-common/src/wiki-storage.ts`

Add a `WikiGraph` type and `buildGraph()` export. Shape:

```ts
export type WikiGraph = {
  nodes: Array<{
    id: string;          // pageId (or broken-target pageId)
    title: string;       // page title; for broken targets use the raw link target
    exists: boolean;     // false for broken-link placeholder nodes
    tags: string[];
    pitch?: string;
    scope: 'beacon' | 'coordinator';
  }>;
  edges: Array<{
    source: string;      // pageId of the linking page
    target: string;      // pageId of the linked page (exists or placeholder)
    kind: 'link';        // forward direction (source links to target); reverse derived in UI
  }>;
};

export async function buildGraph(): Promise<WikiGraph>
```

Implementation:
- `const metas = await listPages();` (all coordinator pages).
- For each page, `readPage(page.id)` to get `content`, then reuse the private `extractWikiLinks(content)` (already in this file) to get outgoing targets.
- Build a node per page: `{ id, title, tags, pitch, scope, exists: true }`.
- Collect edges `{source: page.id, target: linkTarget, kind:'link'}` for each outgoing link.
- For any link target not present among pages, add a placeholder node `{ id: target, title: target, exists: false, tags: [], scope: <source page scope> }` (so the missing page node is addressable in the graph).
- Dedupe edges (a page may link the same target twice). Dedupe nodes by `id`.
- Return `{ nodes, edges }`.

NOTE: `listPages(meta)` does NOT include `pitch`/`content`, so `buildGraph` must `readPage` each (it needs `pitch` for the node + `content` for links) — reuse the pattern already used by `lintPages`.

Tests: `drone-swarm-common/test/wiki-storage.test.ts` — add cases:
- buildGraph returns a node per page and edges for outgoing wikilinks.
- reverse direction: inferring incoming is a data-shaping concern but the graph should include the edge from the linking page; verify an orphan (no links either way) still appears as a node.
- broken link target appears as `exists:false` placeholder node + an edge to it.
- no duplicated edges when a page links the same target twice.

## Step 2 — Coordinator `GET /api/wiki/graph` route

File: `drone-coordinator/src/routes/wiki.ts`

Add after the existing `/wiki/tags` (or near `/wiki`):

```ts
app.get('/wiki/graph', async () => {
  const { buildGraph } = await import('drone-swarm-common');
  return buildGraph();
});
```

No query params needed (v1 renders the whole graph; focus/expand is a client-side view concern, not a refetch). Endpoint returns `{ nodes, edges }`.

Tests: `drone-coordinator/test/wiki-routes.test.ts` (new or extended) —
- seed a few pages (two linked, one orphan, one broken-link target) and assert `GET /api/wiki/graph` returns the expected nodes (all pages present incl. exists:false placeholder) and edges.
- Uses temp `setKnowledgeBaseDir(mkdtemp())` isolation already established.

## Step 3 — Install the graph library

- **IMPORTANT — plan deviation (user-approved):** `react-force-graph` CANNOT be installed under this repo's pnpm 11.8 supply-chain policy. It declares a direct dep on `3d-force-graph-vr` → `aframe` → `three-bmfont-text` (git-resolved), which pnpm's `blockExoticSubdeps` default rejects. The user approved **`force-graph` (v1.51.4) directly** — the same author's engine that `react-force-graph` wraps, with a clean npm-only dep tree that installs cleanly. It is imperative (not a React component), so our thin wrapper instantiates it in a `useEffect`.
- Install: `cd drone-coordinator-ui && pnpm add force-graph`.
- Verify `tsc --noEmit` still passes.

## Step 4 — Graph data+types + thin wrapper component

File: `drone-coordinator-ui/src/lib/types.ts`
- Add `WikiGraphNode`, `WikiGraphEdge`, `WikiGraph` mirroring the coordinator response.

File: `drone-coordinator-ui/src/hooks/use-wiki-graph.ts` (new)
- `useWikiGraph(enabled?: boolean)` hook: `authFetch('/api/wiki/graph')` → `{ graph, loading, error, refetch }`. When `enabled` is false, does NOT fetch (avoids graph fetch in grid view). Mirrors `useWikiPages.ts`.

File: `drone-coordinator-ui/src/lib/wiki-graph-utils.ts` (new)
- `buildFocusedSubgraph(graph, focusedNodeId)` — pure function: node + direct in/out neighbors + only edges touching it. Used by the page to compute the focused subgraph (keeps the component dumb).

File: `drone-coordinator-ui/src/components/wiki-graph.tsx` (new) — thin wrapper isolating the library.
- Props: `nodes`, `edges`, `focusedNodeId?`, `onNodeFocus`, `onClearFocus`, `onOpenPage`, and a `forceGraphFactory` injectable (defaults to the real `ForceGraph`).
- `useEffect` (once) instantiates `ForceGraph(container)`, wires `.nodeId('id')`, `.linkSource('source')`, `.linkTarget('target')`, `.nodeRelSize`, `.linkDirectionalArrowLength`, `.linkWidth`, `.nodeColor` (blue for exists, amber for placeholder), `.onNodeClick` → focus, `.onNodeDoubleClick` → open, `.onBackgroundClick` → clear; `_destructor` on cleanup.
- Second `useEffect` pushes `graphData({nodes, links: edges})` and adjusts `nodeRelSize` (10 focused / 6 unfocused).
- Testability: `forceGraphFactory` lets tests inject a fake handle; no canvas needed.

Tests:
- `wiki-graph-utils.test.ts`: focused subgraph keeps node+neighbors, keeps only touching edges, orphan (no edges) → node alone, incoming-neighbor case.
- `wiki-graph.test.tsx`: fake handle asserts graphData shape, nodeId/source/target wiring, click→focus, double-click→open, background→clear, focused node size, destructor on unmount.

## Step 5 — `/wiki` page: view toggle + graph integration

File: `drone-coordinator-ui/src/pages/wiki.tsx`

- Use `useSearchParams`: `graphView = searchParams.get('view') === 'graph'`, `focusedNodeId = searchParams.get('node')`.
- `setGraphView(next)` sets/deletes `view` (deletes `node` when leaving graph).
- `setFocusedNode(pageId|null)` sets/deletes `node`.
- Header: toggle `Button` (`variant={graphView ? 'outline' : 'default'}`, label `Grid`/`Graph`), "New Page" hidden in graph view.
- Graph branch (`graphView ? ... : ...`):
  - Focused node preview panel (when focusedNode found): title, id, "Show all" (clears `node`), "Open full page" (navigates), pitch, tag badges.
  - `WikiGraphView` with `nodes/edges = focusedSubgraph ?? graph`, `focusedNodeId`, callbacks → `setFocusedNode`/`setFocusedNode(null)`/`navigate`.
- Grid branch unchanged (search + grid + pagination).
- Hook: `useWikiGraph(graphView)` so graph fetch only happens in graph view.

Tests (`wiki.test.tsx`):
- Graph view: stub `@/components/wiki-graph` to a div, assert fetch to `/api/wiki/graph` + "Grid" toggle rendered.
- Grid view: assert NO `/api/wiki/graph` fetch.
- (Type the mock fetch as `(url, init?) => Promise<Response>` to avoid the tuple-typing error on `.mock.calls`.)

## Step 6 — Validation (MUST pass)

1. LSP diagnostics clean across all touched files (use `lsp__get_diagnostics` per file).
2. `cd drone-coordinator-ui && pnpm run typecheck` (covers new component/hook/types).
3. Root `pnpm lint:eslint` + `pnpm lint:prettier` passes.
4. Root fast suite: `pnpm test` (vitest) passes, including new drone-swarm-common + coordinator tests.
5. UI suite: `cd drone-coordinator-ui && NODE_ENV=test npx vitest run` passes, including new graph tests.
6. Full build: `pnpm -r run build` (drone-core, drone-swarm-common, drone-coordinator rebuild first so the route resolves the new export; UI build runs vite).

## Validation criteria checklist

- [x] `buildGraph()` in `wiki-storage.ts` returns `{ nodes, edges }` with all pages as nodes, forward edges, dedup, and `exists:false` broken-link placeholders.
- [x] `GET /api/wiki/graph` (coordinator only) returns the graph from the coordinator's own store; no beacon changes.
- [x] `force-graph` installed and UI typechecks.
- [x] `useWikiGraph` hook + `wiki-graph` component isolate the library; data/nav callbacks are tested.
- [x] `/wiki?view=graph` toggles grid ⇄ graph; `?node=<pageId>` persists focused node; back returns to same mode+node.
- [x] Click node → neighborhood focus/expand; inline preview has an "Open full page" link; "Show all" resets; clicking empty canvas clears focus.
- [x] Orphans appear as nodes; broken-link targets are visible as `exists:false` nodes.
- [x] LSP clean + typecheck + lint + fast tests + UI tests + build all pass.

---

# COMPLETED 2026-09-04

Execution results (all validation criteria met):

- **Step 1** `buildGraph()` + `WikiGraph`/`WikiGraphNode`/`WikiGraphEdge` types in `drone-swarm-common/src/wiki-storage.ts`; reuses private `extractWikiLinks`; all pages as nodes, forward edges deduped, `exists:false` placeholders for broken targets, pitch carried. 5 new storage tests.
- **Step 2** coordinator `GET /api/wiki/graph` route (added before `/wiki/:pageId` so the static path wins). Extended `drone-coordinator/test/wiki-routes.test.ts` with a graph test (nodes incl. placeholder, edges).
- **Step 3** **DEVATION**: `react-force-graph` blocked by pnpm 11.8 `blockExoticSubdeps` (transitive `3d-force-graph-vr`→`aframe`→git-resolved `three-bmfont-text`). User approved **`force-graph` v1.51.4** (the engine `react-force-graph` wraps) — installed cleanly.
- **Step 4** UI: `lib/types.ts` graph types; `hooks/use-wiki-graph.ts` (enabled-gated fetch); `lib/wiki-graph-utils.ts` `buildFocusedSubgraph`; `components/wiki-graph.tsx` thin imperative wrapper (injectable `forceGraphFactory`). Tests: 4 util + 5 component.
- **Step 5** `pages/wiki.tsx`: `?view=graph` toggle (sessions-style button), `?node=` focus state, focused-node preview panel (title/id/pitch/tags/Show all/Open full page), graph branch vs grid branch. Tests: 2 new page tests.
- **Validation** `pnpm -r run build` ✓; `pnpm lint:eslint` + `pnpm lint:prettier` ✓; root fast suite 2770 passed / 14 pre-existing skips ✓; UI suite 84 passed ✓; LSP clean on all touched files ✓.

## Notes / lessons
- **pnpm 11.8 `blockExoticSubdeps` blocks `react-force-graph`**: its transitive `3d-force-graph-vr → aframe → three-bmfont-text` (git-resolved) violates the supply-chain policy. The standalone `force-graph` engine (same author) has a clean npm-only dep tree and works. Worth checking any future candidate library's transitive deps for git-resolved subdeps before promising a specific package.
- **`force-graph` is imperative, not a React wrapper**: instantiate `new ForceGraph(containerEl)` in a `useEffect`; chain setter methods; call `_destructor()` on cleanup. Design the wrapper's factory as an injectable seam for testability.
- **`useWikiGraph(enabled)` gating**: hooks must be called unconditionally, but the graph fetch should be skipped in grid view — an `enabled` param on the hook (default true) avoids fetching when `?view` isn't graph.
- **jsdom can't render `force-graph`**: canvas/svg layout doesn't work in tests. Stub the component (`vi.mock('@/components/wiki-graph', ...)`) in page tests; unit-test the wrapper via an injected fake `forceGraphFactory`.
- **Fastify static route vs param**: `/wiki/graph` must be registered BEFORE `/wiki/:pageId` or Fastify matches the param route. Placed it right after `/wiki/tags`.