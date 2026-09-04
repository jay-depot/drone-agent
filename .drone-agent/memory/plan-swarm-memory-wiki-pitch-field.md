---
key: plan-swarm-memory-wiki-pitch-field
tags:
  []
created: 2026-09-04T22:40:18.463Z
updated: 2026-09-04T22:52:06.587Z
---

# Plan: H1 — "One-sentence pitch" as official swarm memory wiki schema field

## Summary

Make the wiki page `pitch` an official, stored schema field and source the swarm-memory RAG prompt fragment from it (field-first, `matchedChunk` fallback), replacing the current purely procedural assembly of the pitch from the best-scoring vector chunk.

Current behavior: `memory-retrieval.ts` builds `entry.pitch = truncatePitch(result.matchedChunk ?? '')` from `GET /wiki/semantic-search`'s `matchedChunk` (an arbitrary vector chunk). `memory-fragment.ts` renders `— {pitch}` in the `# Swarm Memory` fragment. `DroneWikiPageMeta` has NO pitch field.

Target: a stored optional `pitch?: string` on every wiki page that RAG reads from day one.

## Decisions locked in (from grilling)

1. Field name: `pitch`, typed `pitch?: string` (optional) on `DroneWikiPageMeta`.
2. Optional on ALL write paths — no migration; existing pages (and pages written without a pitch) stay valid.
3. RAG source of truth: `/wiki/semantic-search` enriched to carry `pitch` from page metadata; retriever prefers `result.pitch` over `result.matchedChunk` (no fallback = field only is rejected; we keep matchedChunk fallback for uncurated pages).
4. All 5 write surfaces updated: `swarm__wiki_write`, coordinator UI editor, drone-swarm CLI, migration tool (`migrateWikiPage`→`putBeaconAsset`), beacon + coordinator PUT routes.
5. UI display: pitch on the wiki DETAIL page info card and in the EDIT form. Grid/list card untouched.
6. Seeds: update BOTH the librarian system prompt AND the memory-wiki skill seed body to instruct writing a concise `pitch`. (Existing installed skill copies are not force-updated — only the seed text; the persona prompt has its auto-repair mechanism via `repairSeededLibrarianAssets` + `PRIOR_LIBRARIAN_PROMPT_MARKERS`.)

## Dependencies / order

All steps independent EXCEPT: must add `pitch` to schema type FIRST (everything depends on it). Order:
1. drone-core type
2. drone-swarm-common storage (frontmatter build/parse) + tests
3. rocket routes (beacon + coordinator PUT, semantic-search enrich) + tests — depends on 1,2
4. agent swarm plugin (tools-wiki, memory-retrieval, memory-fragment) + tests — depends on 3 (semantic-search response shape)
5. drone-swarm CLI + client + tests — depends on 1
6. migration wiki.ts + beacon-client pass-through — depends on 1
7. coordinator UI (types, editor, detail) + tests — depends on 1
8. coordinator default-assets seeds (librarian persona + memory-wiki skill) + tests

## Step 1 — drone-core type

File: `drone-core/src/wiki-types.ts`

Add optional `pitch` to `DroneWikiPageMeta`:
```ts
export type DroneWikiPageMeta = {
  id: string;
  title: string;
  scope: 'beacon' | 'coordinator';
  tags: string[];
  sources: string[];
  /** Optional one-sentence summary (the "pitch"). Shown in RAG results. */
  pitch?: string;
  createdAt: string;
  updatedAt: string;
};
```
Then run `pnpm -r run build` (drone-core dist must be rebuilt before dependent packages typecheck against it).

## Step 2 — drone-swarm-common storage

File: `drone-swarm-common/src/wiki-storage.ts`

- `buildFrontmatter(meta)`: add `lines.push(`pitch: ${meta.pitch}`)` only when `meta.pitch` is non-empty (keep frontmatter clean for optional field).
- `writePage(...)`: add a trailing optional parameter `pitch?: string` (after `sources`), include in `meta`.
- `readPage(...)`: parse pitch; leave absent → undefined.
- `listPages(...)`: NOTE — builds each meta explicitly field-by-field, so `pitch` must be added there too (not just readPage).

Tests: write a page WITH a pitch and read it back; assert frontmatter contains `pitch:`; write without a pitch and assert read pitch is `undefined`/absent; assert `listPages` includes pitch.

## Step 3 — Beacon + coordinator routes

Beacon: `drone-beacon/src/routes/wiki.ts`
- `PUT /wiki/:pageId` Body: add `pitch?: string`; pass to `writePage(..., tags ?? [], sources ?? [], pitch ?? undefined)`.
- `GET /wiki/semantic-search`: extend `PageMetaLite` with `pitch?: string`; populate local branch from `listPages()` and coordinator branch from proxied `/wiki` list; emit per result.

Coordinator: `drone-coordinator/src/routes/wiki.ts`
- `PUT /wiki/:pageId` Body: add `pitch?: string`; pass to `writePage(..., tags ?? [], sources ?? [], pitch ?? undefined)`.

Tests: semantic-search returns pitch when present, absent otherwise; beacon+coordinator PUT round-trip (pitch keep + absent). Coordinator route tests MUST call `setKnowledgeBaseDir(mkdtemp())` + cleanup (coordinator setup does NOT isolate the KB dir).

## Step 4 — Drone-agent swarm plugin

- `tools-wiki.ts` `createWikiWriteTool`: add `pitch` inputSchema property (optional); forward `pitch` in PUT body.
- `memory-retrieval.ts`: `SearchRouteResult.pitch?: string`; `entry.pitch = truncatePitch(result.pitch ?? result.matchedChunk ?? '')`.
- `memory-fragment.ts`: doc comment only.

Tests: retrieval (field-first when both; fallback when only matchedChunk), fragment renders stored pitch, `swarm-tool-input-validation.test.ts` wiki_write PUT-body pitch assertion.

## Step 5 — drone-swarm CLI + client

- `client.ts` `writeWikiPage` body: add `pitch?: string`.
- `index.ts` `wiki write`: parse `--pitch`; forward; add to usage.

Tests: `drone-swarm/test/cli.test.ts` write with `--pitch` asserts parsed body.

## Step 6 — Migration tool

- `wiki.ts` `migrateWikiPage` PUT body: `...(data.pitch ? { pitch: data.pitch } : {})`.

Tests: `drone-agent/test/migration.test.ts` beacon→coordinator migrate carries pitch.

## Step 7 — Coordinator UI

- `lib/types.ts`: `WikiPageMeta.pitch?`, `CreateWikiPageRequest.pitch?`.
- `wiki-editor.tsx`: pitch state, preload, form Input, submit body.
- `wiki-detail.tsx`: Pitch row in info card (only when present).
- Grid (`wiki-page-grid.tsx`) UNCHANGED.

Tests: editor loads + submits pitch; new `wiki-detail.test.tsx` renders/omits pitch.

## Step 8 — Coordinator default-assets seeds

- `default-assets.ts`: librarian prompt step 4 = write a one-sentence `pitch`; `PRIOR_LIBRARIAN_PROMPT_MARKERS` switched to a NUMBER-AGNOSTIC phrase marker (the pitch generation renumbers the summarize step 4→5, so a numbered marker breaks);
- memory-wiki skill body: `pitch:` frontmatter example + instruction line.

Tests: prompt + skill seed contain pitch guidance; repair tests still pass.

## Final step — Validation (MUST pass)

1. LSP clean across touched packages.
2. `pnpm -r run build` passes (rebuild drone-core first).
3. `pnpm lint` (root: eslint --fix + prettier) passes.
4. `pnpm test` fast suite passes (root vitest) + `drone-coordinator-ui` `NODE_ENV=test vitest run`.
5. Pre-existing failures (unrelated): session-param-events.test.ts (3) + beacon-ws.test.ts (1) typecheck; UI index.css warnings.

---

# COMPLETED 2026-09-04

Execution results (all validation criteria met):

- **Step 1** drone-core `DroneWikiPageMeta.pitch?: string` added; build passes.
- **Step 2** drone-swarm-common `wiki-storage.ts`: `buildFrontmatter` emits `pitch:` only when non-empty; `writePage` gained trailing optional `pitch?: string`; `readPage` and `listPages` parse/pass `pitch` through (listPages needed an explicit field — not a spread). 3 new storage tests.
- **Step 3** beacon+coordinator PUT routes accept optional `pitch`; beacon `/wiki/semantic-search` enriched with metadata pitch (`PageMetaLite.pitch`). New beacon semantic-search tests (pitch present/absent), beacon PUT round-trip tests, new `drone-coordinator/test/wiki-routes.test.ts` (uses temp KB dir).
- **Step 4** agent swarm: `tools-wiki.ts` `wiki_write` accepts+forwards `pitch`; `memory-retrieval.ts` prefers `result.pitch ?? result.matchedChunk`; `memory-fragment.ts` doc comment only. New retrieval/fragment/tools tests.
- **Step 5** drone-swarm `client.ts` `writeWikiPage` body + CLI `--pitch` flag + usage; CLI test extended.
- **Step 6** migration `wiki.ts` copies `pitch` through to the PUT body; new migration test.
- **Step 7** coordinator UI: `types.ts`, `wiki-editor.tsx` (field), `wiki-detail.tsx` (Pitch row). New `wiki-detail.test.tsx`; editor tests extended.
- **Step 8** `default-assets.ts`: librarian persona step 4 (pitch) + markers made number-agnostic; memory-wiki skill pitch example/instruction; tests extended.
- **Validation** build ✓, lint ✓, fast tests 2764 passed / 14 pre-existing skips ✓, UI 73 passed ✓, LSP clean on touched source. Pre-existing failures untouched (see above).

## Notes / lessons
- **listPages was NOT a spread**: `wiki-storage.listPages` builds each meta explicitly field-by-field, so `pitch` had to be added there too. Easy to miss when adding a schema field — grep for explicit field lists.
- **file__apply_diff fuzz can silently no-op**: reported success with a mangled `\n`-escaped diff but wrote nothing; always re-read the file to confirm the edit landed, especially for multi-line property additions (hit in tools-wiki.ts).
- **coordinator route tests must isolate the wiki KB dir**: coordinator `setupDb` does NOT redirect `setKnowledgeBaseDir`; route tests that PUT wiki pages write to `./knowledge-base`. Call `setKnowledgeBaseDir(mkdtemp())` + cleanup, mirroring beacon tests.
- Prettier's markdown pass reformats tracked `.drone-agent/memory/*.md` (cosmetic diffs expected after `pnpm lint`).