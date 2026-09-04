---
key: plan-swarm-memory-wiki-pitch-field
tags:
  []
created: 2026-09-04T22:40:18.463Z
updated: 2026-09-04T22:40:18.463Z
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

- `buildFrontmatter(meta)`: add `lines.push(\`pitch: ${meta.pitch}\`)` only when `meta.pitch` is non-empty (keep frontmatter clean for optional field).
- `writePage(...)`: add a trailing optional parameter `pitch?: string = ''` (after `sources`), include in `meta`.
- `readPage(...)`: parse `pitch: (frontmatter.pitch as string | undefined) || undefined` (do NOT coerce to empty string; leave absent → undefined).
- `listPages(...)` already spreads `page` meta → carries `pitch` through `readPage`.

Signature: `writePage(id, title, scope, content, tags = [], sources = [], pitch?: string)`.

Tests: `drone-swarm-common/test/wiki-storage.test.ts` — add a test that writes a page WITH a pitch and reads it back; assert frontmatter contains `pitch:`; write without a pitch and assert read pitch is `undefined`/absent.

## Step 3 — Beacon + coordinator routes

Beacon: `drone-beacon/src/routes/wiki.ts`
- `PUT /wiki/:pageId` Body type: add `pitch?: string`; pass to `writePage(..., tags ?? [], sources ?? [], body.pitch ?? undefined)`. Coordinator-proxy branch already forwards `request.body` wholesale → carries pitch.
- `GET /wiki/semantic-search`: extend `PageMetaLite` with `pitch?: string`; populate local branch from `listPages()` results (`p.pitch`); coordinator branch from proxied `/wiki` list (`m.pitch`). Include `pitch: (meta.pitch as string | undefined)` in each emitted result object.

Coordinator: `drone-coordinator/src/routes/wiki.ts`
- `PUT /wiki/:pageId` Body type: add `pitch?: string`; pass to `writePage(..., tags ?? [], sources ?? [], body.pitch ?? undefined)`.

Tests:
- `drone-beacon/test/wiki-semantic-search.test.ts`: assert result exposes `pitch` when the page's frontmatter has one; assert `pitch` absent/undefined when none.
- Add/adjust a beacon or coordinator route test covering PUT with a `pitch` body value (round-trip).
- `drone-beacon/test/wiki-routes` / coordinator route tests: coverage for pitch round-trip (see existing wiki route tests for patterns).

## Step 4 — Drone-agent swarm plugin

Files:
- `drone-agent/src/plugins/swarm/tools-wiki.ts` — `createWikiWriteTool`: add `pitch: { type: 'string', description: 'Optional one-sentence summary...' }` to inputSchema properties (NOT required); include `pitch: params.pitch` in the PUT body if present (pass through; omit if undefined/empty).
- `drone-agent/src/plugins/swarm/memory-retrieval.ts` — in `retrieve()`: `SearchRouteResult` add `pitch?: string`; build `SwarmMemoryEntry.pitch` as `truncatePitch(result.pitch ?? result.matchedChunk ?? '')` (field-first, chunk fallback). Also decide: `pitch` should pass the stored value through `truncatePitch` (still caps at 240) — yes, keep truncation as safety.
- `drone-agent/src/plugins/swarm/memory-fragment.ts` — UNCHANGED logic (already renders `entry.pitch` via `pitchOf`), but add a doc comment noting pitch now sourced from the schema field. (Optional; no behavior change.)

Tests:
- `drone-agent/test/plugins/swarm/memory-retrieval.test.ts` — add cases: (a) result has BOTH `pitch` and `matchedChunk` → entry.pitch uses `pitch`; (b) result has only `matchedChunk` → falls back to it.
- `drone-agent/test/plugins/swarm/memory-fragment.test.ts` — existing tests still pass (they inject `pitch` directly into cache). Add one assertion showing the fragment renders the stored pitch unchanged.

## Step 5 — drone-swarm CLI + client

File: `drone-swarm/src/client.ts`
- `writeWikiPage` body type param: add `pitch?: string`.

File: `drone-swarm/src/index.ts`
- `wiki write` command: parse `args.flags.pitch`; include `...(args.flags.pitch ? { pitch: args.flags.pitch } : {})` in the write body. Add `--pitch` to usage string.

Tests: add/extend `drone-swarm` CLI test asserting `wiki write --pitch "..."` sends the pitch in the body (see existing CLI test patterns).

## Step 6 — Migration tool

File: `drone-agent/src/runtime/migration/wiki.ts`
- In `migrateWikiPage`, when building the PUT body, include pitch copy-through: `...(data.pitch ? { pitch: data.pitch } : {})` alongside title/content/tags/sources.

(beacon-client.ts `putBeaconAsset` takes `Record<string, unknown>` — no type change needed; it spreads body.)

Tests: add/extend `drone-agent/test/migration.test.ts` wiki-migration case asserting pitch is carried across a migrate.

## Step 7 — Coordinator UI

Files:
- `drone-coordinator-ui/src/lib/types.ts` — `WikiPageMeta` add `pitch?: string`.
- `drone-coordinator-ui/src/pages/wiki-editor.tsx` — add a `pitch` state, a form `<Input>` (with label "Pitch" + helper "One-sentence summary of this page"), preload from existing page, include in `CreateWikiPageRequest` body. Add to the editor test (`wiki-editor.test.tsx`) asserting the field loads and submits.
- `drone-coordinator-ui/src/pages/wiki-detail.tsx` — render `page.pitch` if present in the info card (e.g. a "Pitch" row near title / above content). Add to detail test (`wiki.test.tsx` or a detail assertion).
- `drone-coordinator-ui/src/lib/types.ts` `CreateWikiPageRequest` add `pitch?: string`.

Grid (`wiki-page-grid.tsx`) deliberately UNCHANGED.

## Step 8 — Coordinator default-assets seeds

File: `drone-coordinator/src/default-assets.ts`
- `WIKI_LIBRARIAN_SYSTEM_PROMPT`: add a step/instruction: after creating/updating a page, write a concise one-sentence `pitch` summarizing what the page is about (pass `pitch` to `swarm__wiki_write`). Because the persona prompt has auto-repair, also update `PRIOR_LIBRARIAN_PROMPT_MARKERS` so pre-existing seeded personas get the new instruction (add a distinctive new phrase as a marker; see existing `repairSeededLibrarianAssets`).
- `MEMORY_WIKI_SKILL_BODY`: add `pitch: ...` example to the frontmatter YAML block in the skill body + a short instruction line ("Include a concise one-sentence pitch field"). NOTE: installed skill copies are NOT force-updated (existing design) — seed text changes only.

Tests: `drone-coordinator/test/default-assets.test.ts` — assert the new seed text includes `pitch` guidance (persona prompt marker + skill body).

## Final step — Validation (MUST pass)

1. LSP diagnostics clean across all touched packages (typescript LSP; check via lsp__get_diagnostics per file).
2. `pnpm -r run build` passes (rebuilds dist for drone-core first so dependents resolve the new type).
3. `pnpm -r run lint` passes (eslint + prettier).
4. Fast test suite `pnpm -r run test` passes — includes new unit tests added in each step.
5. (Optional/slow, at discretion) `pnpm -r run test:integration` if swarm paths integrate.

## Validation criteria checklist

- [ ] `DroneWikiPageMeta.pitch?: string` exists in drone-core; build passes.
- [ ] `writePage`/`readPage` round-trip the pitch through frontmatter; page without pitch reads back `undefined`.
- [ ] Beacon + coordinator PUT accept optional `pitch`.
- [ ] `GET /wiki/semantic-search` returns `pitch` from metadata when present.
- [ ] Retriever uses stored `pitch` when present, falls back to `matchedChunk` otherwise.
- [ ] `swarm__wiki_write`, drone-swarm CLI, migration tool all accept/forward `pitch`.
- [ ] UI editor + detail render/edit `pitch`; grid untouched.
- [ ] Seeds (librarian persona + memory-wiki skill) instruct `pitch`.
- [ ] LSP clean + build + lint + fast tests pass.