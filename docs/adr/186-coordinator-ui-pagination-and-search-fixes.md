---
tags: [decision, coordinator-ui, pagination, search, bug-fix, react]
related: [modules/drone-coordinator-ui.md, decisions/088-coordinator-ui-bug-fixes-batch-1.md]
---

# 186: Coordinator UI pagination + wiki search fixes

**Status**: Implemented (2026-09-03, branch `feat/coordinator-ui-cleanup`, commits `864addce`..`1d874a67`)

## Context

Four UI defects in the coordinator web console (`drone-coordinator-ui/`), all
in the pagination and wiki-search surfaces:

1. **Pagination was anemic and lost position.** The three client-side
   paginated pages (personas, skills, wiki) used zero-based `page` state with no
   URL binding, and the sessions page used a server-side `offset` that was
   likewise not URL-bound. Navigating into an item and pressing Back always
   landed on the first page of results. The range indicator showed only the
   current page count ("12 of 95") rather than the on-screen range.

2. **Wiki search crashed.** `/api/wiki/search` returns
   `DroneWikiSearchResult[]` — an array of `{ page, snippet, score }` wrapper
   objects (from drone-swarm-common's `searchPages`) — but the grid rendered
   them directly as if they were `WikiPageMeta[]`. The card render then hit
   `page.tags.length` on the wrapper, where `tags` actually live at
   `.page.tags`, throwing `can't access property "length", $.tags is undefined`.

3. **Back buttons used hardcoded paths.** The detail/editor pages' "← Back"
   buttons called `navigate('/list')` with a hardcoded path, dropping the
   `?offset=N` query param — so backing out of an item always landed on the
   first page.

4. **UI test harness broke under `NODE_ENV=production`.** React's entry point
   branches on `process.env.NODE_ENV` at module load. With a global
   `NODE_ENV=production` exported, it loads its production build, which does NOT
   export `act` (only the dev build does) — so react-dom-test-utils crashed with
   `React.act is not a function` across every UI test regardless of code.

## Decision

1. **Offset-aware pagination with URL persistence.** New shared
   `usePaginationOffset(pageSize)` hook (`src/hooks/use-pagination-offset.ts`)
   reads/persists the `offset` query param via react-router's `useSearchParams`.
   Pushing a new offset writes a history entry, so navigating into an item and
   pressing Back returns to the exact page of results. Offset 0 is omitted from
   the URL to keep the first page clean. Non-page-aligned and invalid offsets
   are clamped to a valid page boundary. The three client-side pages
   (personas/skills/wiki) convert from zero-based `page` state to `offset`
   bound to the URL; sessions (already server-side offset) wires to the hook and
   displays the range using the server-reported total.

2. **Range indicator.** New shared `paginationRange(offset, pageSize, total)`
   helper (`src/lib/pagination.ts`) renders the on-screen range ("13-24 of 95")
   instead of just the current page count. All items remain reachable
   regardless of offset: client-side pages fetch the full list and slice it;
   sessions drives Next off the server count.

3. **Flatten wiki search results.** In `wiki.tsx`, the search response is
   flattened before setting state: `results.map(r => r.page)` (guarded by
   `Array.isArray`), so the card grid renders page metadata directly.

4. **Back buttons use history back.** Every "← Back" button on the detail and
   editor pages (wiki, persona, skill, session detail; wiki/persona/skill
   editors; beacon detail) switches from `navigate('/list')` to `navigate(-1)`
   (browser history back), restoring the exact page the user was viewing
   including the offset param.

5. **Hermetic test script.** The `test` script pins `NODE_ENV=test` so the
   suite is hermetic regardless of the host's exported `NODE_ENV`.

## Tests

- `src/lib/pagination.test.ts` — 6 `paginationRange` unit tests (full middle
  page, first page, last-page clip, single item, zero total, start-beyond-total).
- `src/hooks/use-pagination-offset.test.tsx` — 5 hook tests (default 0, valid
  offset, non-page-aligned clamp, negative fallback, non-numeric fallback).
- `src/pages/wiki.test.tsx` — wiki search flattening regression test asserting
  the tags badge renders (fails against the pre-fix flatten).

Full coordinator-ui suite green (25 tests), typecheck, build, and lint clean.

## Alternatives considered

- **Keep `page` state, just add URL binding** — rejected: `offset` is the
  canonical pagination unit (sessions already uses it server-side) and unifies
  the four pages on one model.
- **`navigate('/list?offset=N')`** — rejected: hardcoding the offset in the
  back path couples every detail page to its list's pagination shape; history
  back is simpler and always correct.

## Consequences

- Pagination position survives navigation into and out of items on all four
  paginated pages.
- Wiki search no longer crashes on the wrapper-vs-meta shape mismatch.
- UI tests are hermetic under any host `NODE_ENV`.
- The `usePaginationOffset` + `paginationRange` pair is the shared pagination
  idiom for future coordinator-ui pages.
