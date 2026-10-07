---
tags: [decision, coordinator-ui, wiki, browser, table, filter, graph, adr]
related: [decisions/187-coordinator-ui-wiki-browser-improvements.md, decisions/189-coordinator-wiki-tag-scaleup.md, decisions/193-wiki-pitch-field.md, decisions/194-wiki-graph-view.md, decisions/195-wiki-graph-visual-polish.md, decisions/186-coordinator-ui-pagination-and-search-fixes.md, decisions/204-coordinator-ui-error-display-sweep-and-ws-initial-fix.md, modules/drone-coordinator-ui.md, modules/drone-swarm-common.md, modules/drone-core.md]
---

# 216: Coordinator UI wiki browser — table layout, filters, and filter-aware graph

**Status**: Implemented (2026-09-18/19) · **Branch**: `feat/swarm-memory-table-redesign` · **Plan**: project-memory `plan-coordinator-wiki-browser-upgrade` — *deleted from project memory after ingest*

**Summary**: The coordinator's knowledge-base wiki browser was a **card grid** — wasteful of vertical space, unsortable, un-narrowable beyond a single server-side `?tag=`, and with `sources[]` rendered as inert badges. This decision replaces the grid with a **six-column table**, adds a **full filter set** (tag, source, date range, page state) that **composes with keyword search**, makes columns **click-to-sort**, wires **sources → session logs**, and — the distinctive part — **extends the filters into the graph view** so the graph **dims to the filtered subset** instead of silently ignoring it. It also **pre-caches two derived values** (`wordCount`, `linkCount`) on the shared page metadata, which is what makes the table's Word Count column and the `has links` filter possible server-free, and which de-duplicates the graph's own inline word count. Items **A1–A4** of the `memory-wiki-browser-improvements` backlog (B/C/E1/F1/H1/A5 had already shipped as [[decisions/191-topology-live-ws-status]]–[[decisions/195-wiki-graph-visual-polish]]).

## Context

The wiki is the swarm's durable memory, and the librarian pipeline keeps writing pages into it, so the browser is the main surface for reading that memory. The pre-existing browser ([[decisions/187-coordinator-ui-wiki-browser-improvements]], [[decisions/189-coordinator-wiki-tag-scaleup]]) stacked one card per page (id, scope, tags, updated), fetched the whole list with `GET /api/wiki` (only `?tag=` server-side), paginated client-side at `PAGE_SIZE = 12`, and offered only a keyword substring search (`GET /api/wiki/search`). Three gaps drove this work:

1. **Scanability.** A card grid costs ~6× the vertical space of a table row and offers no way to compare pages on any dimension (word count, sources, dates).
2. **Narrowing.** There was no way to answer "which pages came from this session?" or "which pages have no outgoing links?" or "what changed this week?" — the data was in the metadata but unsurfaced.
3. **Provenance.** `sources[]` (the session IDs a page was distilled from) rendered as opaque badges with no link to the conversation.

The backlog item list (A1–A4) was a first-draft, LLM-produced artifact, and the grilling session that turned it into a plan corrected several of its premises — most notably that **A4's "make transcript pages pretty" was already done** by [[decisions/202-session-chat-view-blob-delivery]] (the session-detail view defaults to a human-friendly chat view), so A4 collapsed to "link the sources." A second framing correction: the graph's existing `?tags=1` param is a **tag-node *visibility* toggle**, not a filter, so the new tag filter could not reuse it.

## Decision

The locked decisions, in the user's terms:

1. **Scope = A1–A4 plus filter-aware graph plus the derived-field pre-cache.** Explicitly out: a real version number (D1), transcript tools / eidetic memory (G1, seeded separately as `plan-transcript-tools-eidetic-memory`), semantic/vector search for the web UI (a separate phase), and server-side sort/filter/pagination (deferred — the graph hits the scaling wall first).
2. **Derived fields on the shared type.** Add **required** `wordCount: number` and `linkCount: number` to `DroneWikiPageMeta` (drone-core), computed in the storage layer's `readPage`/`writePage`, **never persisted to frontmatter**. A shared `countWords(content)` helper is extracted; `buildGraph` reuses `meta.wordCount` instead of recomputing it. Required (not optional) so every consumer is forced to sweep.
3. **Server computes the derived values; the client sorts and filters.** The main list already loads the full set, so sort + filter are pure client logic over the loaded array — no new query API. (Accepted limitation: client-side is not sustainable as the corpus grows; server-side is "much later.")
4. **A1 — table replaces the grid.** Six columns: **Title, Tags, Created, Updated, Word Count, Source Sessions**. Drop `ID` and `Scope` (scope is always `coordinator`; id is the row link target). No Pitch column. Tag cell = ≤3 badges + a `+N` chip, full list in a `title` tooltip. `PAGE_SIZE` 12 → 25. Shared by `/wiki` and `/wiki/tag/:tag`.
5. **A3 — click-to-sort.** Sortable: Title, Created, Updated, Words, Sources. **Tags is not sortable.** Click ⇒ asc, click again ⇒ desc, single-column. Default **Updated desc**. Search results stay relevance-sorted until a column is clicked.
6. **A2 — filter set.** Tag = **free-text comma list + autocomplete, OR semantics** (not a multi-select — that is "terrible" per the user). Source = comma-list text + autocomplete, **contains-match**. Date = two date inputs with an active-field toggle (Created \| Updated, default **Updated**). Page state = three toggles: **Has links** (outgoing), **Has sources**, **Recently created** (**fixed 7-day** window).
7. **A4 — sources → session logs.** Detail-page source badges become links to `/sessions/:id` (no pre-validation), plus a per-source **"Filter"** affordance that navigates to `/wiki?srcs=…`.
8. **Search composes with filters (AND).** Keyword search is unchanged and, with filters active, its candidate set is narrowed client-side. The search box is **list-only**. Clearing the search box **refetches the full list** (a bug fix — see below).
9. **Graph — filters dim, never prune.** Filters reach the graph by joining page metadata against the graph nodes **client-side** (no `WikiGraphNode`/`buildGraph` payload change). The filter bar renders in **both** views. Focus ∩ filter **intersect**. Tag nodes follow the tag filter. Dimming is **render-only** — `nodes`/`edges` identity is unchanged, so there is no d3 reheat and no drift/fade animation.
10. **Autocomplete is hand-rolled**, mirroring the Config page's `lib/config-completions.ts` pattern (a pure helper + an inline suggestion dropdown). Not `<datalist>`, not `@base-ui/react`.
11. **`/wiki/tag/:tag` stays on its server-side `?tag=` path** (preserves [[decisions/189-coordinator-wiki-tag-scaleup]]); it gets the shared table + sorting + pagination, but **no filter bar and no search box**.
12. **Param collision resolved as `?tags=` = filter, `?tagnodes=1` = tag-node visibility** (renamed from `?tags=1`; the button label stays "Tags").

### URL parameters

All params are **omitted when at default** (mirrors `?offset`). Any filter/sort change resets `offset` to 0.

| Purpose | Param | Values |
|---|---|---|
| Tag filter | `tags` | comma list, OR |
| Source filter | `srcs` | comma list, contains-match |
| Date field | `dfield` | `created` \| `updated` (default `updated`) |
| Date from / to | `dfrom`, `dto` | `YYYY-MM-DD` |
| Has links | `links` | `1` |
| Has sources | `hasSources` | `1` |
| Recently created | `recent` | `1` |
| Sort column | `sort` | `title` \| `created` \| `updated` \| `words` \| `sources` |
| Sort direction | `dir` | `asc` \| `desc` |
| Tag-node visibility (graph) | `tagnodes` | `1` |
| *(existing)* view / focus / offset | `view`, `node`, `offset` | unchanged |

### Data flow

```
GET /api/wiki ──> useWikiPages() ──> pages: WikiPageMeta[]  (incl. wordCount/linkCount)
                        │
    ┌───────────────────┼──────────────────────────────┐
    │                   │                              │
 list view          filter+sort state            graph view
    │              (useWikiFilterState, URL)           │
    ├─ keyword search ──┤ (GET /api/wiki/search)        │
    │  → candidate set  │                              │
    │                   ▼                              ▼
    │            applyWikiFilters(meta, filters)   join node.id → meta
    │                   │                              │
    │            sortWikiPages(...)                filterActiveIds: Set<string>
    │                   │                              │
    └──────► paginate → <WikiPageTable/>         <WikiGraphView filterActiveIds/>
                                                       │
                                            dim = focusDim ∥ filterDim (render-only)
```

The key simplification: the derived fields land in the **same object** `searchPages` returns (it calls `listPages` internally), so a single `applyWikiFilters` predicate runs unchanged over either the full list or the search results.

## Implementation

**Foundation — `drone-core` + `drone-swarm-common`**
- `drone-core/src/wiki-types.ts` — `DroneWikiPageMeta` gains `wordCount` + `linkCount` (documented "derived from the page body; never written to frontmatter").
- `drone-swarm-common/src/wiki-storage.ts` — new exported `countWords(content)`; `readPage` computes `wordCount` and guards `linkCount` (oversized page ⇒ `0`, no throw, matching `buildGraph`/`lintPages`); `writePage` reuses the `links` list it already computes for the downward-link check (`linkCount = links.length`); `listPages` projects both fields; `buildGraph` reads `meta.wordCount`.
- Swept every construction site (`DroneWikiPageMeta` consumers): 4 beacon test fixtures + `drone-coordinator-ui/src/lib/types.ts`.

**Pure UI logic — `drone-coordinator-ui/src/lib`, `hooks`**
- `lib/wiki-filters.ts` — `WikiFilters` type, `parseWikiFilters`, `applyWikiFilters(page, filters, now?)`, `countActiveFilters`, `filtersAreDefault`, `RECENT_WINDOW_DAYS = 7`.
- `lib/wiki-sort.ts` — `WikiSortKey`/`SortDir`, `parseWikiSort`, `sortWikiPages` (`null` key = relevance/server order, passthrough; returns a new array).
- `lib/wiki-filter-suggestions.ts` — `computeCommaTokenSuggestions(query, candidates, limit)` (token after the last comma), `distinctTags`, `distinctSources`.
- `hooks/use-wiki-filter-state.ts` — URL-backed filter + sort state; omits defaults; **resets `offset`** on every change; preserves `view`/`node`/`tagnodes`; `setSort` implements the asc→desc toggle cycle (`updated` starts desc).

**Components + pages**
- `components/wiki-suggest-input.tsx` — controlled text input with an inline suggestion dropdown (opens on focus, closes on Escape/select/blur; suggestions applied with `onMouseDown` so the click lands before blur).
- `components/wiki-filter-bar.tsx` — tag/source suggest inputs, date-field toggle + two date inputs, three state toggles, Clear button, active-filter count badge. Holds each comma-list field as a **raw-text draft** that only re-seeds on external token changes.
- `components/wiki-page-table.tsx` — the six-column table (`table-fixed`, container-capped; fixed widths on the narrow columns so the unsized **Title** column absorbs the remainder and **truncates with an ellipsis**); sortable headers with ▲/▼; Delete button with `stopPropagation`. **Replaces the deleted `components/wiki-page-grid.tsx`.**
- `pages/wiki.tsx` — table + filter bar in both views; `pages → (search candidates) → applyWikiFilters → sortWikiPages → paginate → <WikiPageTable/>`; computes `filterActiveIds`; `?tagnodes=1` rename.
- `pages/wiki-tag.tsx` — table + sorting + pagination (no filter bar / search box).
- `pages/wiki-detail.tsx` — source badges → `Link` to `/sessions/:id` + per-source "Filter" button.

**Graph — `components/wiki-graph.tsx` (purely additive)**
- New `filterActiveIds?: ReadonlySet<string> | null` prop → mirrored into a ref (like `tagsVisibleRef`) → a repaint effect cloned from the `tagsVisible` effect.
- The dim predicate at the four node sites and the link accessors now OR-in filter dimming (`focus ∩ filter`); edges dim when either endpoint is filtered out; unselected tag nodes fade.
- No `nodes`/`edges` identity change ⇒ no `graphData` re-push, no d3 reheat.

## Notable findings en route

1. **The backlog item list was a first-draft artifact, not a spec.** The grilling pass replaced "Tag (multi-select)" with a comma-list text input ("multi-select will be terrible"), confirmed A4's transcript-prettiness was already done ([[decisions/202-session-chat-view-blob-delivery]]), and discovered the `?tags` param collision that became the `?tags` (filter) vs `?tagnodes` (visibility) split.
2. **A controlled input that re-formats from parsed tokens eats the separator as you type.** The first filter-bar implementation rendered the input value as `tokens.join(', ')`, so typing `ops,` re-parsed to `['ops']`, re-rendered as `ops`, and the comma vanished — a second tag was **unenterable**. Fixed with a raw-text draft that re-seeds only on external token changes. The unit test that caught it rendered the bar with a **static** value prop and typed `ops, design`, observing `['opsdesign']`.
3. **A pre-existing `wiki.test.tsx` break was found and fixed.** The file had `vi.mock('@/components/wiki-graph', …)` **inside a test body**, which vitest rejects with a hoisting error — the file failed on the base tree too. Fixed by hoisting the mock to module scope (the file was rewritten for the table anyway).
4. **`table-fixed` + an unsized column is the clean way to cap a table.** Fixed widths on the narrow columns and no width on Title lets the browser allocate the remainder; the `<td>` isn't a block formatting context, so truncation needs an inner `<div className="truncate">` (not a class on the cell).
5. **Reusing the graph's focus-dim machinery for filters was nearly free.** The dim was already a single `dimmed` boolean derived from `focusSetsRef.current.neighborIds`; generalizing it to `focusDim ∥ filterDim` needed one new ref + one repaint effect and touched no other behavior.
6. **A pre-existing, load-sensitive flake in `sessions.test.tsx` is not caused by this work.** The `SessionsPage live session events` refetch assertions intermittently fail under full-suite file-parallelism (they pass in isolation and serially); the file fails on the base tree too. A 5000ms `waitFor` budget did **not** fix it (proving the callback is genuinely lost, not slow), and two attempted fixes were reverted after measurement. Left untouched and documented (see the project insight logged for this session).

## Consequences

- The wiki browser is scannable (dense rows, comparable columns) and narrowable (five filter dimensions) without a server round-trip.
- `sources[]` is now a navigable link into the conversation that produced a page, which closes the provenance loop the librarian pipeline opened.
- Filters now **mean something in the graph**: instead of the graph ignoring active filters, it dims to the matching subset (focus ∩ filter), reusing the existing dim-and-spotlight machinery.
- Two derived values are now first-class on the shared page metadata. Because they are required, every producer was swept — and because they are never written to frontmatter, on-disk pages are unchanged. This is also a prerequisite for the deferred graph perf work ([[decisions/194-wiki-graph-view]] computes `wordCount` inline today).
- Accepted limitations carried forward: client-side sort/filter is not sustainable at scale; `sources[]` remains an unvalidated soft reference; and `wiki-graph.tsx` (1096 lines) remains over the size rule (split deferred).

## Validation

- **Static/type**: `pnpm -r run build`, `pnpm run typecheck`, `pnpm --filter drone-coordinator-ui exec tsc --noEmit` (the UI package's ground truth — vitest/esbuild does not typecheck), and `pnpm lint` all clean; LSP clean on every touched file.
- **Tests**: fast suite `pnpm test` **3059 passed**; feature tests (wiki + graph) **111/111**; `wiki-graph.test.tsx`'s 32 pre-existing tests pass **unchanged** (6 filter-dim cases added → 38). New suites: `wiki-filters` (13), `wiki-sort` (8), `wiki-filter-suggestions` (7), `use-wiki-filter-state` (8), `wiki-page-table` (9), `wiki-filter-bar` (7), storage `countWords`/derived-field/frontmatter round-trip tests.
- **Manual canvas smoke** (the one non-automatable gate, per [[decisions/195-wiki-graph-visual-polish]]): auto-fit, label tiers, tag gravity, dim-and-spotlight, filter-dim, focus∩filter, both themes.

## Related

- [[decisions/187-coordinator-ui-wiki-browser-improvements]] — the prior browser work (markdown read view, working links, tag pages) this builds on
- [[decisions/189-coordinator-wiki-tag-scaleup]] — the server-side tag path the tag page keeps
- [[decisions/193-wiki-pitch-field]] — the `pitch` field (kept off the table, still on detail/graph)
- [[decisions/194-wiki-graph-view]] — the graph this makes filter-aware
- [[decisions/195-wiki-graph-visual-polish]] — the dim/focus machinery reused for filter dimming
- [[decisions/186-coordinator-ui-pagination-and-search-fixes]] — the offset/pagination + search-flattening foundation
- [[decisions/202-session-chat-view-blob-delivery]] — why A4's "pretty transcripts" was already satisfied
- [[modules/drone-coordinator-ui]] — the package this changes
- [[modules/drone-swarm-common]] — `countWords` + the derived fields
- [[modules/drone-core]] — `DroneWikiPageMeta`
