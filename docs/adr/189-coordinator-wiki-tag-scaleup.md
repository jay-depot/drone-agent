---
tags: [decision, coordinator, drone-core, drone-swarm-common, coordinator-ui, wiki, tags]
related: [modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-swarm-common.md, modules/drone-core.md, decisions/187-coordinator-ui-wiki-browser-improvements.md]
---

# 189: Coordinator-side wiki tag filtering (scale-up)

**Status**: Implemented (2026-09-03, branch `feat/memory-wiki-browser-improvements`, commit `e744b76`)

## Context

[187-coordinator-ui-wiki-browser-improvements](187-coordinator-ui-wiki-browser-improvements.md) added a virtual tag
page (`WikiTagPage` at `/wiki/tag/:tag`) that filtered the *full* page list
client-side by `tags.includes(tag)`. That approach works while the page list is
small, but it will not scale to the thousands of memory-wiki pages the
`coordinator-wiki-librarian` persona ultimately produces — every tag view
re-fetched and re-filtered the entire corpus on the browser. The follow-up plan
`plan-coordinator-wiki-tag-scaleup` moved tag filtering to the coordinator so
the server returns only the pages for a given tag.

## Decision

Move tag filtering to the coordinator backend, exposing a `?tag=` query param on
the list endpoint and a dedicated tag-index endpoint.

1. **Storage filter** (`drone-swarm-common/src/wiki-storage.ts`). `listPages()`
   now accepts an optional `tag?: string`. When provided, it filters the returned
   `DroneWikiPageMeta[]` to pages whose `tags` array includes the tag — a
   case-sensitive exact match, consistent with how tags are stored and displayed.
   No-arg callers (the beacon list route, search) are unaffected.

2. **Tag index** (`drone-swarm-common/src/wiki-storage.ts`). A new `listTags()`
   returns `Array<{ tag: string; count: number }>` — all distinct tags across
   pages with their page counts, sorted by count descending then tag ascending.
   It reuses `listPages()` internally (no duplicated traversal).

3. **Reserved-name guard** (`drone-swarm-common/src/wiki-storage.ts`).
   `writePage()` rejects `id === 'tags'` (case-insensitive) with a clear error:
   `'Page id "tags" is reserved; it conflicts with the wiki tag index route.'`.
   `writePage()` is the single write choke point (the coordinator PUT calls it
   directly; the beacon's coordinator-scope PUT proxies to the coordinator PUT
   which calls it), so this covers every creation path. Note: it also blocks a
   beacon-scoped page named `tags`, which is acceptable/harmless — the static
   `/wiki/tags` route needs the name available.

4. **Type** (`drone-core/src/wiki-types.ts` + `drone-core/src/index.ts`). New
   `export type DroneWikiTagCount = { tag: string; count: number }`, re-exported
   from the package index. Mirrored in the UI as `WikiTagCount`
   (`drone-coordinator-ui/src/lib/types.ts`).

5. **Coordinator routes** (`drone-coordinator/src/routes/wiki.ts`).
   - `GET /wiki` accepts an optional `Querystring { tag?: string }` and passes it
     through to `listPages(tag)`.
   - New `GET /wiki/tags` returns `listTags()`. This is a static route;
     find-my-way prioritizes it over `/wiki/:pageId`, which is exactly why the
     reserved-name guard (3) prevents shadowing a page literally named `tags`.

6. **UI server-side filter** (`drone-coordinator-ui/src/pages/wiki-tag.tsx`)
   and type (`src/lib/types.ts`). `WikiTagPage` now fetches
   `GET /api/wiki?tag=<tag>` instead of fetching all pages and filtering
   client-side. It keeps the header (tag name + count from the returned array
   length), `WikiPageGrid`, pagination, the empty state, and a `useEffect` that
   refetches when the `:tag` route param changes. The client-side filter was
   removed (no duplicated filtering logic).

## En-route fix: vitest subpath-alias swallow

While bringing up the new coordinator route tests, every wiki route request
500'd with `ERR_MODULE_NOT_FOUND`. Root cause: the root `vitest.config.ts`
installs a bare-ID alias for `drone-swarm-common` → `src/index.ts`, and vitest's
alias matching is a **prefix** match — so subpath imports like
`drone-swarm-common/wiki-storage` (and `/spawner`, `/tls`) were swallowed by the
base alias and failed to resolve from test-runnable source. The beacon's wiki
routes already imported the base `drone-swarm-common` package (which re-exports
everything from `wiki-storage`). The coordinator's wiki routes imported the
subpath, so they were aligned to the base package, and the `makeApp` test helper
now imports `setKnowledgeBaseDir` from the base package so it shares the exact
module instance the routes resolve to.

## Tests

- **New** `drone-coordinator/test/routes/wiki.test.ts` — 5 injection cases:
  `GET /api/wiki?tag=X` returns only pages with tag X; no-match returns `[]`;
  `GET /api/wiki/tags` returns distinct tags with counts sorted
  (count desc then tag asc); `PUT /api/wiki/tags` is rejected with 400
  (reserved name); `PUT /api/wiki/foo` with tag X then `GET /api/wiki?tag=X`
  includes it.
- **`drone-swarm-common/test/wiki-storage.test.ts`** — added 4 cases (filter by
  tag, no-match empty array, `listTags` aggregate + sort, reserved `tags` /
  case-insensitive `TAGS`); 25 total.
- **`drone-coordinator-ui/src/pages/wiki-tag.test.tsx`** — updated 3 tests to
  assert the page calls `/api/wiki?tag=<tag>` and renders the returned pages.

Root `pnpm test` 2711 passed / 14 skipped; coordinator-ui suite 49 passed;
typecheck, build, and lint clean; LSP clean on all touched files.

## Alternatives considered

- **Keep filtering client-side** — rejected: does not scale to thousands of
  memory-wiki pages (the motivating gap from ADR 187).
- **Change the `/wiki` list route response shape** — rejected: the existing
  `GET /api/wiki` returns a flat `DroneWikiPageMeta[]`; a tag filter is an
  additive query param, not a schema change.

## Consequences

- Tag views are now server-side queries (`GET /api/wiki?tag=X`), so the browser
  only transfers/renders the matching pages regardless of corpus size.
- A new `GET /api/wiki/tags` index powers future tag navigation
  (tag-cloud/list surfaces).
- Page id `tags` is reserved globally across the wiki storage layer; attempting
  to create a page named `tags` (any case) fails with a clear message.
- The coordinator wiki routes now import the base `drone-swarm-common` package
  (matching the beacon), avoiding the vitest subpath-alias swallow for testable
  route code.
