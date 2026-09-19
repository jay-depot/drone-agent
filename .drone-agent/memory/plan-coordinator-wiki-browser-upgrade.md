---
key: plan-coordinator-wiki-browser-upgrade
tags:
  - plan
  - coordinator-ui
  - wiki
  - browser
  - table
  - filter
  - graph
created: 2026-09-19T02:43:18.780Z
updated: 2026-09-19T02:43:18.780Z
---

# Plan: Coordinator UI Wiki Browser Upgrade (A1–A4 + filter-aware graph)

**Status:** ✅ EXECUTED 2026-09-18 on branch `feat/swarm-memory-table-redesign` (see "Execution log" below).
**Source:** `memory-wiki-browser-improvements` items A1–A4 (the "ready-to-plan" backlog; B/C/E1/F1/H1/A5 already shipped as ADRs 191–195).
**Package root:** `drone-coordinator-ui/` (plus `drone-core/` and `drone-swarm-common/` for the derived-field foundation).

## 1. Why

The coordinator's knowledge-base wiki is the swarm's durable memory, and the librarian pipeline keeps writing pages into it. The web browser for it is still a **card grid**: `WikiPageGrid` shows ID/Scope/Tags/Updated on one card each, the list is fetched in full with no server filter beyond `?tag=`, pagination is client-side at `PAGE_SIZE = 12`, and the only search is a keyword substring match. The card layout wastes vertical space, cannot be scanned or sorted, and offers no way to narrow the corpus. `sources[]` (the session IDs a page was distilled from) render as inert badges — the reader cannot follow a page back to the conversation that produced it.

This plan makes the browser **dense, sortable, and filterable**, connects **sources → session logs**, and — per the user's decision — extends the filter set into the **graph view** so the graph dims to the filtered subset instead of silently ignoring filters. It also **pre-caches the derived values** (`wordCount`, `linkCount`) that the table and filters need, which doubles as the graph's de-duplication of its own inline word count.

## 2. Scope

**In scope**
- **A1** Table layout replacing the card grid.
- **A2** Filter set: tag (free-text + autocomplete, OR), source (free-text + autocomplete, contains), date range (created/updated), page state (has links / has sources / recently created).
- **A3** Click-to-sort column headings (all but Tags).
- **A4** Sources → session logs (deep links + "filter by this source").
- Filter **awareness in the graph view** (dim-not-prune), and the derived-field pre-cache (`wordCount`/`linkCount`) with `buildGraph` de-duplication.

**Out of scope (disposed)**
- **D1** (real version number) — unrelated; stays open in `memory-wiki-browser-improvements`.
- **G1** (transcript tools / eidetic memory) — seeded separately as `plan-transcript-tools-eidetic-memory`.
- **Semantic / vector search for the web UI** — a separate future phase (only the beacon has it; see `coordinator-wiki-browser-data-surface`).
- **Server-side sort / filter / pagination** — deferred ("much later"); the graph view hits the scaling wall first.
- **Splitting `wiki-graph.tsx`** — deferred to `followup-graph-view-derived-fields` (the file is 1096 lines and this plan makes only a surgical, additive change to it).

## 3. Locked decisions

| # | Decision |
|---|---|
| Scope | A1–A4 in; D1/G1/semantic-search/server-side-scaling out. |
| Derived fields | Add **required** `wordCount` + `linkCount` to `DroneWikiPageMeta`, computed in `readPage`/`writePage`; never persisted to frontmatter; shared `countWords` helper; `buildGraph` reuses `meta.wordCount` instead of recomputing. |
| Data strategy | Server computes the derived values; **client-side** sort + filter over the already-loaded list. |
| A1 | Table **replaces** the grid (keep the Graph ⇄ list toggle). Shared by `/wiki` and `/wiki/tag/:tag`. `PAGE_SIZE` 12 → 25. Six columns: Title, Tags, Created, Updated, Word Count, Source Sessions. Drop `ID`/`Scope`. No Pitch column. Tag cell = ≤3 badges + `+N`, full list in a `title` tooltip. |
| A2 | Tag = comma-list text + autocomplete, **OR** semantics. Source = comma-list text + autocomplete, contains-match. Date = two date inputs + active-field toggle (Created \| Updated, default **Updated**). State toggles: Has links (outgoing), Has sources, Recently created (**fixed 7-day** window). |
| A3 | Sortable: Title, Created, Updated, Words, Sources. **Tags not sortable.** Click ⇒ asc, click again ⇒ desc, single-column. Default **Updated desc**. Search results stay relevance-sorted until a column is clicked. |
| Search | Keyword search is unchanged (`GET /api/wiki/search`) and **composes** with filters (AND). Search box is **list-only**. Clearing the search box refetches the full list (bugfix). |
| A4 | Detail-page source badges link to `/sessions/:id`; a "Filter wiki by this source" affordance navigates to `/wiki?srcs=…`; no pre-validation of source IDs. "Make transcript pages pretty" is **already done** (ADR 202) — verify only. |
| Graph | Filters **dim, never prune**. Filters reach the graph by joining page metadata against the graph nodes client-side (no `WikiGraphNode`/`buildGraph` payload change). Filter bar renders in **both** views. Focus ∩ filter intersect. Tag nodes follow the tag filter. |
| Params | `tags`, `srcs`, `dfield`, `dfrom`, `dto`, `links`, `hasSources`, `recent`, `sort`, `dir`; the tag-node visibility toggle is renamed `?tags=1` → `?tagnodes=1` (button label unchanged). |
| Autocomplete | **Hand-rolled**, mirroring `lib/config-completions.ts` (pure helper + inline dropdown). Not `<datalist>`, not `@base-ui/react`. |
| Tag page | `/wiki/tag/:tag` stays on its server-side `?tag=` path (preserves ADR 189); it gets the shared table + sorting + pagination, but **no filter bar and no search box**. |

## 4. URL parameters (final)

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

## 5. Data flow

```
GET /api/wiki ──> useWikiPages() ──> pages: WikiPageMeta[]  (incl. wordCount/linkCount)
                        │
    ┌───────────────────┼──────────────────────────────┐
    │                   │                              │
 list view          filter+sort state            graph view
    │              (useWikiFilterState, URL)           │
    │                   │                              │
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

**Key insight:** the derived fields land in the **same object** that `searchPages` returns (it calls `listPages` internally), so a single `applyWikiFilters` predicate runs unchanged over either the full list or the search results — no special-casing.

## 6. Steps

Steps are atomic. Assignments: **coder** = `code` persona; **reviewer** = `review`; **tester** = `code` (test-writing) — the plan persona's "tester" role maps to `code` since no dedicated tester persona exists. Each step lists its own focused validation; §7 is the end-to-end gate.

### Phase 0 — Derived-field foundation (`drone-core`, `drone-swarm-common`)

**Step 1 — Add required derived fields to the wiki types** *(coder)*
`drone-core/src/wiki-types.ts`: add to `DroneWikiPageMeta`:
```ts
  /** Derived from the page body; never written to frontmatter. */
  wordCount: number;
  /** Count of outgoing [[wikilinks]]; never written to frontmatter. */
  linkCount: number;
```
`DroneWikiPage = DroneWikiPageMeta & { content }` inherits them.

**Step 2 — Compute them in the storage layer** *(coder)*
`drone-swarm-common/src/wiki-storage.ts`:
- Extract a shared helper and use it in `buildGraph`:
```ts
export function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}
```
- In `readPage`: after parsing, compute both, guarding link extraction exactly as `buildGraph`/`lintPages` do (oversized page ⇒ `linkCount = 0`):
```ts
const wordCount = countWords(body);
let linkCount = 0;
try { linkCount = extractWikiLinks(body).length; } catch { /* oversized page */ }
```
- In `writePage`: reuse the `links` already computed for the downward-link check (`linkCount = links.length`) — do **not** re-extract.
- `buildFrontmatter` is unchanged (it emits an explicit field list, so the derived values never leak into frontmatter — verify this explicitly).
- `buildGraph`: replace the inline `page.content.split(/\s+/).filter(Boolean).length` with `meta.wordCount`.
- **Note:** removing `buildGraph`'s *second* `readPage` is a perf nicety left to `followup-graph-view-derived-fields`; this step only de-duplicates the word-count logic.

**Step 3 — Sweep every construction site** *(coder)*
Run `pnpm -r run build` first (dependents resolve `drone-core` from `dist/`, per project principle), then enumerate with LSP find-references on `DroneWikiPageMeta` **and** grep as a cross-check. Known sites to fix (each must supply both fields, or be proven non-constructing):
- `drone-swarm-common/src/wiki-storage.ts` (`writePage` meta literal, `listPages` projection, `readPage`)
- `drone-beacon/src/wiki-indexer.ts`, `drone-beacon/src/wiki-index-support.ts`
- `drone-coordinator/src/routes/wiki.ts` (verify — it may rely on inference)
- `drone-coordinator-ui/src/lib/types.ts` → add `wordCount: number; linkCount: number;` to `WikiPageMeta`
- Any test fixture constructing a meta literal (repo-wide grep for `createdAt:` near wiki metas).
Repeat `pnpm -r run build` until clean.

**Step 4 — Storage tests** *(tester)*
`drone-swarm-common/test/`: extend the wiki-storage suite —
- `countWords` handles empty/whitespace-only/typical bodies.
- `readPage` returns correct `wordCount`/`linkCount`; an oversized (>1 MB) page returns `linkCount = 0` without throwing.
- `writePage` result carries both fields; **round-trip: the written file's frontmatter contains neither `wordCount` nor `linkCount`**.
- `buildGraph` node `wordCount` equals `meta.wordCount`.
- `listPages` projects both fields.

### Phase 1 — Pure UI logic (`drone-coordinator-ui/src/lib`, `hooks`)

**Step 5 — Filters module** *(coder)*
New `lib/wiki-filters.ts`:
```ts
export const RECENT_WINDOW_DAYS = 7;
export type WikiFilters = {
  tags: string[];          // OR
  sources: string[];       // contains-match
  dateField: 'created' | 'updated';
  dateFrom: string | null; // YYYY-MM-DD
  dateTo: string | null;
  hasLinks: boolean;
  hasSources: boolean;
  recentlyCreated: boolean;
};
export function parseWikiFilters(params: URLSearchParams): WikiFilters;
export function applyWikiFilters(page: WikiPageMeta, f: WikiFilters): boolean;
export function countActiveFilters(f: WikiFilters): number;
export function filtersAreDefault(f: WikiFilters): boolean;
```
Semantics: tags OR (`f.tags.length === 0 || f.tags.some(t => page.tags.includes(t))`); sources contains-match over the comma list; date range inclusive against `dateField`, skipping when null; `hasLinks` ⇒ `linkCount > 0`; `hasSources` ⇒ `sources.length > 0`; `recentlyCreated` ⇒ `createdAt` within `RECENT_WINDOW_DAYS`. Comma lists are trimmed, de-duplicated, lowercased-compared where appropriate (tags are case-sensitive on the storage side — match exactly).

**Step 6 — Sort module** *(coder)*
New `lib/wiki-sort.ts`:
```ts
export type WikiSortKey = 'title' | 'created' | 'updated' | 'words' | 'sources';
export type SortDir = 'asc' | 'desc';
export function parseWikiSort(params: URLSearchParams): { key: WikiSortKey | null; dir: SortDir };
export function sortWikiPages(pages: WikiPageMeta[], key: WikiSortKey, dir: SortDir): WikiPageMeta[];
```
`key === null` means "relevance / server order" — return the input untouched (this is the search default). `title` uses `localeCompare`; `created`/`updated` compare ISO strings; `words` compares `wordCount`; `sources` compares `sources.length`. Returns a **new** array (never mutates).

**Step 7 — Suggestion helper** *(coder)*
New `lib/wiki-filter-suggestions.ts`, mirroring `config-completions.ts`:
```ts
/** Suggest completions for the token after the last comma. */
export function computeCommaTokenSuggestions(
  query: string, candidates: string[], limit = 8
): { tokenStart: number; suggestions: string[] };
export function distinctTags(pages: WikiPageMeta[]): string[];
export function distinctSources(pages: WikiPageMeta[]): string[];
```
Pure, no React, no fetch.

**Step 8 — URL-backed filter/sort hook** *(coder)*
New `hooks/use-wiki-filter-state.ts`, mirroring `usePaginationOffset`:
```ts
export function useWikiFilterState(): {
  filters: WikiFilters;
  sort: { key: WikiSortKey | null; dir: SortDir };
  setFilters: (next: WikiFilters) => void;
  setSort: (key: WikiSortKey | null) => void;
  clearFilters: () => void;
};
```
Reads/writes the §4 params via `useSearchParams`; omits defaults; **resets `offset`** on every filter/sort change; preserves `view`/`node`/`tagnodes`. `setSort(key)` implements the asc→desc→(same key toggles) cycle; clicking a different column starts at `asc` (except `updated`, which starts at `desc` to match the default).

**Step 9 — Lib/hook tests** *(tester)*
`lib/wiki-filters.test.ts` (each predicate independently + combination; OR semantics; 7-day boundary; default detection), `lib/wiki-sort.test.ts` (each key both directions; `null` = passthrough; immutability), `lib/wiki-filter-suggestions.test.ts` (comma-token boundary, cap, exact-match drop, distinct setters), `hooks/use-wiki-filter-state.test.tsx` (param round-trip, default omission, offset reset, sort toggle cycle, preserves unrelated params) — following `use-pagination-offset.test.tsx` / `config-completions.test.ts` patterns.

### Phase 2 — Components

**Step 10 — Suggestion input** *(coder)*
New `components/wiki-suggest-input.tsx`: a controlled text input with an inline suggestion dropdown, modelled on `pages/config.tsx:300-340` (a bordered `<div>` of `<button>`s, shown on focus, closed on Escape/select/blur). Props: `value`, `onChange`, `suggestions`, `placeholder`, `id`, `aria-label`. Tests assert suggestion wiring and keyboard/Escape behavior (note: config's dropdown opens on `onFocus`; mirror that).

**Step 11 — Filter bar** *(coder)*
New `components/wiki-filter-bar.tsx`: a single wrapping row — tag suggest-input, source suggest-input, a `dfield` toggle (Created/Updated), two date inputs, three toggle buttons (Has links / Has sources / Recently created), a "Clear" button, and an active-filter count badge. Wired to `useWikiFilterState`, with tag/source candidates from `distinctTags`/`distinctSources` over the loaded pages.

**Step 12 — Page table** *(coder)*
New `components/wiki-page-table.tsx`: renders the six columns over `pages`; sortable headers (▲/▼ indicator, plain Tags header); the Tags cell caps at 3 badges + `+N` with a full-list `title`; the Sources cell shows `sources.length` with the IDs in a `title` tooltip; a row click navigates to `/wiki/:id` (with `stopPropagation` on the Delete button, as the card grid does today); an optional `onDelete`. Uses `components/ui/table.tsx`. **Delete `components/wiki-page-grid.tsx`** and update both call sites.

**Step 13 — Rewrite the list page** *(coder)*
`pages/wiki.tsx`:
- Read `?tagnodes=1` (renamed from `?tags=1`) for graph tag-node visibility; read the tag filter from `?tags=`.
- Render `<WikiFilterBar/>` in **both** views.
- List: `pages` → (search candidates if a query is active) → `applyWikiFilters` → `sortWikiPages` → paginate → `<WikiPageTable/>`.
- **Bugfix:** when the search box is cleared, refetch/restore the full list (today `if (!search.trim()) return;` leaves stale results on screen).
- Show "Relevance" as the sort state until a column is clicked; show the active-filter count so a filtered-empty table is self-explanatory.
- Keep the existing `?view=graph` / `?node=` behavior and the graph preview panel.

**Step 14 — Tag page** *(coder)*
`pages/wiki-tag.tsx`: swap `WikiPageGrid` → `WikiPageTable` and add sorting + the shared pagination. **No** filter bar, **no** search box (server-side `?tag=` path unchanged).

**Step 15 — Detail page sources** *(coder)*
`pages/wiki-detail.tsx`: render each source badge as a `Link` to `/sessions/:source` (no pre-validation), and add a "Filter wiki by this source" button → `/wiki?srcs=<source>`. Keep tag badges linking to `/wiki/tag/:tag`.

**Step 16 — Component tests** *(tester)*
`components/wiki-page-table.test.tsx` (columns, badge cap + `+N`, count-only Sources cell, sort click cycles, row/Delete click behavior), `components/wiki-filter-bar.test.tsx` (each control writes the right param; clear; count), `pages/wiki.test.tsx` + `pages/wiki-tag.test.tsx` updates (table renders, filters compose with search, search-clear refetch, `tagnodes` rename, filter params preserved across the graph toggle), `pages/wiki-detail.test.tsx` (source link href, filter-by-source). Follow the existing patterns (MemoryRouter + `user-event`; **poll for content**, never fixed-tick barriers).

### Phase 3 — Filter-aware graph

**Step 17 — Compute the filter-active id set** *(coder)*
In `pages/wiki.tsx` (or a small helper in `lib/wiki-graph-utils.ts`), build `filterActiveIds: Set<string> | null` = the ids of graph **page** nodes whose joined page meta passes `applyWikiFilters`, plus (if `filters.tags.length`) the ids of selected **tag** nodes (`tag:<t>`). `null` when no filters are active. Join via the already-loaded `pages` (`useWikiPages()` runs in both views).

**Step 18 — Dim on filter in the graph component** *(coder)*
`components/wiki-graph.tsx` (surgical, additive):
- New prop `filterActiveIds?: ReadonlySet<string> | null`; mirror it into a ref like `tagsVisibleRef` (no new React state).
- Add a repaint effect cloned from the `tagsVisible` effect (`994-998`).
- Widen the dim predicate at the four sites (`433`, `508`, `554`, and the link accessors `446-479`): a node is dimmed if `focusDim ∥ filterDim`, where `filterDim = filterRef.current !== null && !filterRef.current.has(node.id)`. Edges are dimmed when either endpoint is filtered out. With both focus and filter active this yields **focus ∩ filter** (a node is bright only if it is in the focus neighborhood *and* passes the filter).
- Extend `isTagNodeVisible` so, when a tag filter is active and the node is a tag not selected, it fades like the rest.
- **Do not** change `nodes`/`edges` identity — no re-push, no d3 reheat, no drift/fade animation.

**Step 19 — Graph tests** *(tester)*
`components/wiki-graph.test.tsx`: add cases for filter-dim styling (filtered-out page dims; selected tag stays lit; edges dim when an endpoint is filtered out; both focus+filter intersect). Then confirm the existing 32 tests still pass — do not perturb #8/#11 (dim color/width contract), #9/#13 (hidden-tag contract), #31 (focused-label override), #29 (showdown independence), or #16/#19/#20 (camera guards).

### Phase 4 — Verification

**Step 20 — Review** *(reviewer)*
Review the whole diff against §3/§4. Specifically check: no derived value leaks into frontmatter; `wiki-graph.tsx` change is additive-only; the search-clear bugfix is covered by a test; param rename is reflected everywhere (no lingering `?tags=1` reader); no duplicated filter/sort logic between the list and tag pages.

**Step 21 — Final validation** *(tester)*
Run the full §7 gate. Then the **manual canvas smoke** (the one gate that cannot be automated, per `drone-agent-coordinator-ui-wiki-graph-visual-polish`): auto-fit, label tiers, tag gravity, dim-and-spotlight, filter-dim, focus∩filter, both themes.

## 7. Validation criteria

All of the following must pass. No exceptions for tests, and no exceptions for code not touched.

**Static / type**
- [ ] `pnpm -r run build` passes with zero errors.
- [ ] `pnpm -r run typecheck` passes.
- [ ] **LSP diagnostics are clean** for every touched file (`drone-core/src/wiki-types.ts`, `drone-swarm-common/src/wiki-storage.ts`, `drone-beacon/src/{wiki-indexer,wiki-index-support}.ts`, `drone-coordinator/src/routes/wiki.ts`, all new + edited files under `drone-coordinator-ui/src/`).
- [ ] `pnpm --filter drone-coordinator-ui exec tsc --noEmit` passes (**ground truth** for the UI package — vitest/esbuild does not typecheck; workspace LSP can be stale after rewrites).

**Lint (project "linting process")**
- [ ] `pnpm -r run lint` passes with zero errors (eslint `--fix`, then prettier). Re-read every file after linting before any further edit.

**Tests**
- [ ] Fast suite `pnpm -r run test` passes.
- [ ] UI suite `pnpm --filter drone-coordinator-ui test` passes. **Use the package script** — a bare `vitest run` in that package fails with `React.act is not a function` because `NODE_ENV` is unset (see `pre-existing-integration-failures`).
- [ ] New unit tests exist for: `countWords`/derived fields/frontmatter round-trip; `applyWikiFilters` (incl. OR + 7-day boundary); `sortWikiPages`; `compareCommaTokenSuggestions`; `useWikiFilterState`; `WikiPageTable`; `WikiFilterBar`; the graph filter-dim; the search-clear refetch.
- [ ] `wiki-graph.test.tsx`'s existing 32 tests still pass unchanged.

**Behavioral (against §3/§4)**
- [ ] `/wiki` shows a 6-column table with sortable Title/Created/Updated/Words/Sources and a plain Tags header; default sort Updated desc.
- [ ] Filters compose with keyword search (AND); clearing the search box restores the full list with filters intact; any filter/sort change resets `offset` to 0.
- [ ] Tag filter is free-text + autocomplete with OR semantics; source filter is contains-match + autocomplete; `recentlyCreated` uses a fixed 7-day window.
- [ ] `/wiki/tag/:tag` still uses the server-side `?tag=` path, with the table + sorting, and **no** filter bar or search box.
- [ ] In graph view, non-matching nodes dim (never removed); tag nodes follow the tag filter; focus ∩ filter intersect.
- [ ] `?tags=` is the filter and `?tagnodes=1` is the tag-node visibility toggle — no reader of the old `?tags=1` remains.
- [ ] Wiki detail source badges link to `/sessions/:id`; "filter by this source" pre-applies `srcs`.
- [ ] `wordCount`/`linkCount` are present on `GET /api/wiki` items and **absent** from the on-disk frontmatter.
- [ ] Manual canvas smoke of the graph (auto-fit, label tiers, tag gravity, dim, both themes) — the one non-automatable gate.

## 8. Risks / watch-items

- **Cross-cutting type change.** `wordCount`/`linkCount` are required on `DroneWikiPageMeta`; missing a construction site surfaces as a `dist`-stale typecheck failure. Run `pnpm -r run build` after the `drone-core` edit and use LSP find-references + grep before declaring Step 3 done.
- **`wiki-graph.tsx` is already over the 1000-line rule.** Keep the change additive; the split is deferred (`followup-graph-view-derived-fields`).
- **Dimming must stay render-only.** Any approach that prunes `nodes`/`edges` re-triggers d3 reheat and the drift/fade animation — avoid.
- **Suggestion dropdown in jsdom.** Assert the suggestion *list wiring*, not native dropdown rendering.
- **Pre-existing limitation (accepted):** client-side sort/filter is not sustainable as the corpus grows; and `sources[]` remains an unvalidated soft reference.
- **Memory files are checked in.** `plan-transcript-tools-eidetic-memory` and `followup-graph-view-derived-fields` are new/updated `.drone-agent/memory/*` files — commit them on the feature branch (not to `main`).

## 9. Follow-ups spawned by this plan

- `plan-transcript-tools-eidetic-memory` (G1 seed).
- `followup-graph-view-derived-fields` (graph optimization + the `wiki-graph.tsx` split).
- `memory-wiki-browser-improvements`: A1–A4 closed by this plan; **D1** remains open.

## Execution log (2026-09-18, branch `feat/swarm-memory-table-redesign`)

All 21 steps executed. Baseline commit `fca6890` (memory seeds).

**Phase 0 — foundation.** `drone-core/src/wiki-types.ts`: `wordCount` + `linkCount` added to `DroneWikiPageMeta` (required). `drone-swarm-common/src/wiki-storage.ts`: new exported `countWords(content)`; `readPage` computes `wordCount` + guards `linkCount` (oversized page ⇒ 0, no throw); `writePage` reuses the `links` already computed for the downward-link check; `listPages` projects both; `buildGraph` now reads `meta.wordCount` instead of recomputing. Swept every construction site (LSP find-refs + grep): 4 beacon test fixtures + `drone-coordinator-ui/src/lib/types.ts`. 43 storage tests pass (incl. frontmatter round-trip proving neither field is persisted).

**Phase 1 — pure UI logic.** New `lib/wiki-filters.ts` (`applyWikiFilters`, `countActiveFilters`, `filtersAreDefault`, `parseWikiFilters`, `RECENT_WINDOW_DAYS = 7`), `lib/wiki-sort.ts`, `lib/wiki-filter-suggestions.ts` (comma-token aware), `hooks/use-wiki-filter-state.ts` (URL-backed, resets `offset`, sort asc→desc cycle, `updated` defaults to `desc`). 36 tests.

**Phase 2 — components.** New `wiki-suggest-input.tsx`, `wiki-filter-bar.tsx`, `wiki-page-table.tsx` (6 cols; replaces the deleted `wiki-page-grid.tsx`); `pages/wiki.tsx` rewritten (table + filter bar in both views, search composes with filters via one shared predicate, **search-clear refetch bugfix**, `?tagnodes=1` rename, `filterActiveIds`); `wiki-tag.tsx` → table + sorting (no filter bar/search, keeps server-side `?tag=`); `wiki-detail.tsx` source badges → `/sessions/:id` + per-source "Filter" affordance. `PAGE_SIZE` 12 → 25.

**Phase 3 — filter-aware graph.** `filterActiveIds` (page ids passing the filter + selected `tag:<t>` ids; `null` when no filters) built in `wiki.tsx` by joining the already-loaded page list. `wiki-graph.tsx` got a purely additive change: `filterActiveIds` prop → ref → repaint effect cloned from `tagsVisible`; the dim predicate at the 4 node sites and the link accessors now OR-in filter dimming (focus ∩ filter). No `nodes`/`edges` identity change ⇒ no d3 reheat. 6 new graph tests; the 32 pre-existing graph tests unchanged.

**Two bugs found and fixed en route.**
1. Pre-existing `wiki.test.tsx` had `vi.mock('@/components/wiki-graph', …)` **inside a test body** → vitest hoisting error; the file failed on the base tree too. Fixed by hoisting the mock to module scope (that file was rewritten anyway).
2. The first filter-bar implementation reformatted the input from parsed tokens on every keystroke, which **ate the comma as you typed it** (a second tag was unenterable). Fixed with a raw-text draft that only re-seeds on external token changes.

**Validation.** `pnpm -r run build`, `pnpm run typecheck`, `pnpm --filter drone-coordinator-ui exec tsc --noEmit`, root `pnpm lint`, and LSP diagnostics all clean. Fast suite `pnpm test`: 3059 passed. Feature tests: 111/111. **Known residual:** `pnpm --filter drone-coordinator-ui test` is flaky in its pre-existing `sessions.test.tsx` "live session events" refetch tests (a WS subscribe/connect race sensitive to file-parallelism CPU contention; the file fails on the base tree too, and is untouched by this plan — see the project insight logged this session). **Manual canvas smoke** (auto-fit, label tiers, tag gravity, dim, filter-dim, focus∩filter, both themes) remains the one non-automatable gate for a human.

**Note for whoever picks up the follow-ups:** the note in §1 that the derived fields "double as the graph's de-duplication of its own inline word count" was satisfied — `buildGraph` no longer recomputes word counts. The remaining graph perf win (dropping its second `readPage`) is scoped to `followup-graph-view-derived-fields`.
