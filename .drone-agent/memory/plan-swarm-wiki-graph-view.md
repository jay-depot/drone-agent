---
key: plan-swarm-wiki-graph-view
tags:
  []
created: 2026-09-04T23:07:35.360Z
updated: 2026-09-04T23:07:35.360Z
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

## Step 3 — Install `react-force-graph`

- `cd drone-coordinator-ui && pnpm add react-force-graph`.
- Verify `tsc --noEmit` still passes (peerDep react:* is satisfiable with React 19).

## Step 4 — Graph data+types + thin wrapper component

File: `drone-coordinator-ui/src/lib/types.ts`
- Add `WikiGraphNode`, `WikiGraphEdge`, `WikiGraph` mirroring the coordinator response.

File: `drone-coordinator-ui/src/hooks/use-wiki-graph.ts` (new)
- `useWikiGraph()` hook: `authFetch('/api/wiki/graph')` → `{ graph, loading, error, refetch }`. Mirrors `useWikiPages.ts`.

File: `drone-coordinator-ui/src/components/wiki-graph.tsx` (new) — thin wrapper isolating the library.
- Props: `nodes`, `edges`, `focusedNodeId`, callbacks `onNodeFocus(pageId)`, `onClearFocus()`, `onOpenPage(pageId)`.
- Renders `<ReactForceGraph>` (or the library's container) with `data={{ nodes, links: edgesMappedToSourceTarget }}`.
- Maps our `{source,target}` to the library's `{source,target}` shape.
- `onNodeClick` → focus/expand: compute the node's neighborhood (node + its in/out neighbors) by filtering `nodes`/`edges` to those touching the clicked id; render only that subset while focused (the component receives everything and computes the subgraph, OR the page computes the subset and passes it). RECOMMEND: page computes the focused subgraph and passes only those nodes/edges to the component — keeps the component dumb/testable.
- `onNodeDoubleClick` or an explicit "open" affordance → `onOpenPage`.
- Expose a marker for the focused node (e.g. larger/highlighted radius).
- No fixed-tick/timeout test barriers; tests poll rendered structure (see TUI/Ink principle adapted: in jsdom, assert via screen.findBy* / waitFor on the data-driven UI we control).

## Step 5 — `/wiki` page: view toggle + graph integration

File: `drone-coordinator-ui/src/pages/wiki.tsx`

- Add `view` to URL state using `useSearchParams` (mirror sessions pattern): `const graphView = searchParams.get('view') === 'graph';` and a `setGraphView(next)` that sets/deletes `view`.
- Add a toggle `Button` in the header (next to "New Page"), `variant={graphView ? 'default' : 'outline'}`, label `graphView ? 'Grid' : 'Graph'`, title "Show wiki as a graph / Show wiki as a grid" — styled like the sessions archived toggle.
- Focused node state: `const focusedNodeId = searchParams.get('node');` and setters via `setSearchParams` (`node` set/delete), all within the page or a small hook.
- When `graphView`:
  - Use `useWikiGraph()` to load `{ nodes, edges }` (+ loading/error states).
  - Compute the focused subgraph (when `node` set): node + direct in/out neighbors via checking edge.source===node || edge.target===node.
  - Render a preview panel for the focused node: title, tag badges, pitch (if any), and a link/button "Open full page" → `navigate(`/wiki/${pageId}`)`. Place it beside the graph (or overlaid) — recommended: a slim detail card above/right of the graph when a node is focused.
  - Render the graph component.
  - "Show all" button appears when `node` is set → clears `node` param.
  - Clicking empty canvas → clear focus.
- Otherwise render the existing grid (unchanged).

Routing note: `/wiki` and `/wiki/new` both exist in App.tsx. Since `/wiki?view=graph` is the same route as `/wiki?view=`, no new route needed.

## Step 6 — Validation (MUST pass)

1. LSP diagnostics clean across all touched files (use `lsp__get_diagnostics` per file).
2. `cd drone-coordinator-ui && pnpm run typecheck` (covers new component/hook/types).
3. Root `pnpm lint` (eslint + prettier) passes.
4. Root fast suite: `pnpm test` (vitest) passes, including new drone-swarm-common + coordinator tests.
5. UI suite: `cd drone-coordinator-ui && NODE_ENV=test npx vitest run` passes, including new graph tests.
6. Full build: `pnpm -r run build` (drone-core, drone-swarm-common, drone-coordinator rebuild first so the route resolves the new export; UI build runs vite).

## Validation criteria checklist

- [ ] `buildGraph()` in `wiki-storage.ts` returns `{ nodes, edges }` with all pages as nodes, forward edges, dedup, and `exists:false` broken-link placeholders.
- [ ] `GET /api/wiki/graph` (coordinator only) returns the graph from the coordinator's own store; no beacon changes.
- [ ] `react-force-graph` installed and UI typechecks.
- [ ] `useWikiGraph` hook + `wiki-graph` component isolate the library; data/nav callbacks are tested.
- [ ] `/wiki?view=graph` toggles grid ⇄ graph; `?node=<pageId>` persists focused node; back returns to same mode+node.
- [ ] Click node → neighborhood focus/expand; inline preview has an "Open full page" link; "Show all" resets; clicking empty canvas clears focus.
- [ ] Orphans appear as nodes; broken-link targets are visible as `exists:false` nodes.
- [ ] LSP clean + typecheck + lint + fast tests + UI tests + build all pass.