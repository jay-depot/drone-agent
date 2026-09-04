---
key: plan-coordinator-wiki-tag-scaleup
tags: []
created: 2026-09-03T21:57:40.424Z
updated: 2026-09-04T02:10:00.000Z
---

# Plan: Coordinator-Side Wiki Tag Filtering (Scale-Up)

## Summary

Follow-up to `plan-coordinator-wiki-browser-improvements`. That plan's tag page (`/wiki/tag/:tag`) filters the full page list client-side, which won't scale to thousands of memory-wiki pages. This plan moves tag filtering to the coordinator: a `?tag=` query param on the list endpoint, a `GET /api/wiki/tags` index endpoint, and a reserved-name guard so no page can be created with id `tags` (which would be shadowed by the static `/api/wiki/tags` route).

## Backend changes (drone-coordinator + drone-swarm-common + drone-core)

### 1. Storage: `listPages(tag?)` optional filter — `drone-swarm-common/src/wiki-storage.ts`

Change `listPages()` to accept an optional `tag?: string`. When provided, filter the returned `DroneWikiPageMeta[]` to pages whose `tags` array includes the tag (case-sensitive exact match, matching how tags are stored/displayed). No-arg callers (beacon list route, search) are unaffected.

### 2. Storage: `listTags()` — `drone-swarm-common/src/wiki-storage.ts`

New function returning `Array<{ tag: string; count: number }>` — all distinct tags across pages with their page counts, sorted by count descending then tag ascending. Reuses `listPages()` internally.

### 3. Storage: reserved-name guard — `drone-swarm-common/src/wiki-storage.ts`

In `writePage()`, reject `id === 'tags'` (case-insensitive) with a clear error: `'Page id "tags" is reserved; it conflicts with the wiki tag index route.'`. This is the single write choke point (coordinator PUT calls it directly; beacon's coordinator-scope PUT proxies to coordinator PUT which calls it), so it covers all creation paths. Note: this also blocks a beacon-scoped page named `tags`, which is acceptable/harmless.

### 4. Types — `drone-core/src/wiki-types.ts`

Add `export type DroneWikiTagCount = { tag: string; count: number };` and export it from `drone-core/src/index.ts`. (Mirror in UI `src/lib/types.ts` as `WikiTagCount`.)

### 5. Coordinator routes — `drone-coordinator/src/routes/wiki.ts`

- `GET /wiki` — accept optional `Querystring { tag?: string }`; pass through to `listPages(tag)`.
- `GET /wiki/tags` — return `listTags()`. (Static route; find-my-way prioritizes it over `/wiki/:pageId`, hence the reserved-name guard in step 3.)

### 6. Coordinator route tests — `drone-coordinator/test/routes/wiki.test.ts` (new)

Use the existing `makeApp` helper (`test/helpers/server.ts`) which sets up a temp knowledge-base dir. Cover:

- `GET /api/wiki?tag=X` returns only pages with tag X.
- `GET /api/wiki?tag=X` with no matches returns `[]`.
- `GET /api/wiki/tags` returns distinct tags with counts, sorted.
- `PUT /api/wiki/tags` is rejected (reserved name) with 400.
- `PUT /api/wiki/foo` with tag X then `GET /api/wiki?tag=X` includes it.

### 7. Storage tests — `drone-swarm-common/test/wiki-storage.test.ts`

Add cases: `listPages('tag')` filters; `listTags()` aggregates counts; `writePage('tags', ...)` throws reserved-name error.

## Frontend changes (drone-coordinator-ui)

### 8. Types — `src/lib/types.ts`

Add `WikiTagCount { tag: string; count: number }`.

### 9. Tag page uses server-side filter — `src/pages/wiki-tag.tsx`

Change `WikiTagPage` (from the browser-improvements plan) to fetch `GET /api/wiki?tag=<tag>` instead of fetching all pages and filtering client-side. Keep the header (tag name + count from the returned array length), `WikiPageGrid`, pagination, and empty state. Add a `useEffect` that refetches when `:tag` changes.

### 10. Tag page test — `src/pages/wiki-tag.test.tsx`

Update to assert the page calls `/api/wiki?tag=<tag>` and renders the returned pages.

## Validation Criteria

- `pnpm -r run typecheck` passes (LSP clean in drone-coordinator, drone-swarm-common, drone-core, drone-coordinator-ui).
- `pnpm -r run lint` passes (eslint + prettier).
- `pnpm -r run build` passes (drone-core types must be rebuilt before dependent packages resolve them from dist/).
- `pnpm -r run test` passes — new coordinator wiki route tests, new storage tests, updated UI tag-page test.
- Manual: `GET /api/wiki?tag=ops` returns only ops-tagged pages; `GET /api/wiki/tags` lists tags with counts; `PUT /api/wiki/tags` returns 400; the UI tag page shows only matching pages.
- No dead code; no duplicated filtering logic (client-side filter removed from tag page).

## Executed (2026-09-03)

All 10 steps implemented and verified.

- **Storage** (`drone-swarm-common/src/wiki-storage.ts`): `listPages(tag?)` filters by exact tag match; new `listTags()` returns `{ tag, count }[]` sorted count-desc then tag-asc; `writePage()` rejects reserved id `tags` (case-insensitive) with the specified message.
- **Types** (`drone-core`): `DroneWikiTagCount` added to `wiki-types.ts` and re-exported from `index.ts`; mirrored as `WikiTagCount` in `drone-coordinator-ui/src/lib/types.ts`.
- **Coordinator routes** (`drone-coordinator/src/routes/wiki.ts`): `GET /wiki` accepts `?tag=` and passes through to `listPages(tag)`; new `GET /wiki/tags` returns `listTags()`.
- **Tests**: new `drone-coordinator/test/routes/wiki.test.ts` (5 cases: tag filter, no-match `[]`, tags index sorted, reserved-name 400, PUT-then-filter), new storage cases (filter, no-match, tag counts sort, reserved `tags`/`TAGS`), updated `drone-coordinator-ui/src/pages/wiki-tag.test.tsx` asserting the `?tag=` fetch.
- **UI** (`src/pages/wiki-tag.tsx`): server-side filter — fetches `GET /api/wiki?tag=<tag>`, keeps header/count, grid, pagination, empty state; `useEffect` refetches on `:tag` change; client-side filter removed.

**Notable deviation (en-route fix)**: coordinator wiki routes previously used `import('drone-swarm-common/wiki-storage')` (subpath). That subpath does not resolve in the vitest test environment — the root `vitest.config.ts` alias for `drone-swarm-common` (prefix match) swallows subpath imports, so `drone-swarm-common/wiki-storage`, `/spawner`, and `/tls` all fail to load from test-runnable code. The beacon already used the base `drone-swarm-common` import; aligned the coordinator routes to the base package (which re-exports `wiki-storage`). Also simplified `test/helpers/server.ts` `makeApp` to import `setKnowledgeBaseDir` from the base `drone-swarm-common` (same module instance vitest resolves for the routes) instead of the non-resolving dist file path.

**Validation**: `pnpm -r build`, `pnpm -r typecheck`, `pnpm lint`, `pnpm test` (2711 passed), and `drone-coordinator-ui` full suite (49 passed) all green; LSP clean on all touched files.
