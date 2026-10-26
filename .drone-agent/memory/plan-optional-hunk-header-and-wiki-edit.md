---
key: plan-optional-hunk-header-and-wiki-edit
tags:
  - plan
  - file-plugin
  - swarm-plugin
  - wiki
  - diff-format
created: 2026-10-26T22:54:22.123Z
updated: 2026-10-26T22:54:22.123Z
---

# PLAN: Optional `@@` hunk header in `file__apply_diff` + new `swarm__wiki_edit` tool

Status: READY FOR EXECUTION (confirmed with user 2026-10-26)

## Summary
Two tightly coupled features, both built on the unified-diff parser in `drone-agent`.
1. Make the `@@ -N,M +N,M @@` hunk header in `file__apply_diff` OPTIONAL. A patch with no `@@` header is parsed as ONE content-anchored hunk. The engine already treats headers as advisory (soft lineHint + soft sectionHeading); this removes the "no hunks found" reject on headerless hand-written patches (recurring pain documented in swarm wiki `drone-agent-file-apply-diff-parameter-name-and-hunk-headers`).
2. Add `swarm__wiki_edit`, an agent-side tool that applies the SAME diff format to a wiki page body, and/or updates page metadata fields. `diff` is OPTIONAL too: the tool can be used for field-level changes alone (title/tags/sources/pitch).

Naming convention difference between `file__*` and `swarm__wiki_*` is intentionally out of scope (file will be made consistent later, not today).

## Confirmed design decisions
- D1: `wiki_edit` default scope = 'beacon' (mirrors `wiki_write`).
- D2: Partial-success semantics match `file__apply_diff`: apply successful hunks, PUT the partial result, then surface hunk failures in the error.
- D3: Headerless patch = exactly ONE hunk covering the whole body (no lineHint, no sectionHeading).
- D4: Concurrency: wrap the entire read→patch→PUT span in `withKeyLock('wiki:' + pageId)` (ADR 237 pattern; wiki-tooling-notes documents parallel-edit corruption).
- D5: Librarian tooling IS in scope: add `swarm__wiki_edit` to `coordinator-wiki-librarian` persona allowlist, `memory-wiki` skill, coordinator BUILTIN_HIDDEN_TOOLS, and the default-assets `!` exclusion list.
- D6: Agent-side application (NOT a server PATCH route). Reuse existing beacon GET (`/wiki/:id?scope=`) + PUT (`/wiki/:id`) paths. No beacon/coordinator route changes.
- D7: Metadata fields (`title`, `tags`, `sources`, `pitch`) are optional inputs that DEFAULT to current read values. Accept the known wart: an empty `pitch` is not transmitted by the PUT path (wiki_write only sends pitch when truthy), so clearing a pitch stays a `wiki_write` job.
- D8: `wiki_edit` inputs: `pageId` (required), `scope`, `diff`, `title`, `tags`, `sources`, `pitch`, `additionalProperties: false`. Validation: `pageId` non-empty AND at least one of `diff`/`title`/`tags`/`sources`/`pitch` present, else error "wiki_edit requires at least one change: pass a diff or a metadata field (title, tags, sources, pitch)."
- D9: `formatPatchError` (currently private in `drone-agent/src/plugins/file.ts`) is extracted to a shared home so `file__apply_diff` and `wiki_edit` share it.
- D10: Plugin version bumps: file 0.4.0→0.5.0, swarm 0.2.0→0.3.0 (matches ADR 038/073 format-change bump convention).

## Steps (atomic, ordered, with dependencies)

### Phase A — shared foundation
**Step 1** `drone-agent/src/shared/unified-diff-parser.ts` — add headerless fallback. After the existing `while` loop that collects hunks, if `hunks.length === 0`, parse the whole input as one hunk via existing `classifyBody`:
```ts
if (hunks.length === 0) {
  const hunk = classifyBody(lines, 0, '');
  // push only if it contains actual change lines (else caller's
  // "no hunks found" error stays accurate for garbage input)
  if (hunk.oldLines.length > 0 || hunk.newLines.length > 0) {
    hunks.push(hunk);
  }
}
```
classifyBody already skips empty lines and `\` no-newline markers. Passing 0 ⇒ `lineHint` undefined; '' ⇒ `sectionHeading` undefined. Side benefit: historical bare `@@ ## label` failures now parse (the `@@ label` line becomes a context line).

**Step 2** `drone-agent/test/unified-diff-parser.test.ts` — new describe block "headerless diffs (no @@ hunk header)":
- headerless single hunk: context+old+new parsed; `sectionHeading` undefined; `lineHint` undefined.
- headerless pure-insertion patch parses (oldLines []).
- headerless with only context/change-less lines ⇒ `[]` preserved.
- bare `@@ ## label` body line is treated as context (not a header).
- all existing tests stay green (headers still parse as before).

**Step 3** Extract `formatPatchError`: move the function from `drone-agent/src/plugins/file.ts` into `drone-agent/src/shared/patch-applier/errors.ts` as an `export`; update `file.ts` to import it and remove the local copy. (errors.ts already owns PatchError-adjacent builders.)

Depends on: Step 2 (proves parse behavior) — order A1→A2→A3.

### Phase B — file__apply_diff headerless
**Step 4** `drone-agent/src/plugins/file.ts`:
- Tool description: change "Hunks start with @@ -start,count +start,count @@ [section heading]." to note the header is OPTIONAL; a headerless patch is parsed as one hunk. Update `patch` param description and the "no hunks found" error text the same way (mention the patch must contain `-`/`+` change lines).
- Bump version 0.4.0 → 0.5.0.

**Step 5** `drone-agent/test/file/apply-diff.test.ts` — add: headerless patch applies (e.g. single-line replace on 'line1/line2/line3'); multi-`-`/`+` body applies as one hunk. Existing header tests stay green.

Depends on: Steps 1,3.

### Phase C — swarm__wiki_edit
**Step 6** `drone-agent/src/plugins/swarm/tools-wiki.ts` — add `createWikiEditTool(ctx)` and append it to the `createWikiTools` return array. New imports: `withKeyLock` from `drone-swarm-common` (root; NOT the `/wiki-storage` subpath — vitest swallows bare-ID subpath aliases, ADR 244 lesson), `parseUnifiedDiff` from `../../shared/unified-diff-parser.js`, `applyPatch` from `../../shared/patch-applier.js`, `renderDiffV2` from `../../shared/diff-renderer.js`, `formatPatchError` from `../../shared/patch-applier/errors.js`.
Execute flow:
1. validate (D8)
2. `withKeyLock('wiki:' + pageId, async () => { ... })`
3. GET `${ctx.baseUrl}/wiki/${enc(pageId)}?scope=${scope}`; 404 ⇒ `{success:false, error:'Wiki page not found: <pageId> (scope: <scope>)'}`
4. if diff: `parseUnifiedDiff` → `applyPatch(content.split('\n'), hunks)`; 0 applied hunks ⇒ error (no change written); render applied hunks via `renderDiffV2(`${scope}:${pageId}`, diffHunks, false)` for the `diff` field in the result; partial ⇒ proceed and surface errors.
5. PUT body: `{ title: title ?? page.title, content: patched ?? page.content, scope: scope ?? 'beacon', tags: tags ?? page.tags, sources: sources ?? page.sources, ...(pitch !== undefined ? {pitch} : (page.pitch ? {pitch: page.pitch} : {})) }` (exact wiki_write fetch shape).
6. `!res.ok` ⇒ surface beacon `err.error`. Success ⇒ `{ success:true, page, summary, diff? }`.

**Step 7** `drone-agent/src/plugins/swarm/index.ts` — swarm plugin metadata version 0.2.0 → 0.3.0 (tool registration is automatic via `createWikiTools`).

**Step 8** Tests:
- NEW `drone-agent/test/swarm/wiki-edit.test.ts` (mirror `tools-wiki-search.test.ts` fetch-mock + `toToolResultContent` pattern), covering: missing pageId; no-change rejection (no fetch); diff-only (GET then PUT, body patched, title/tags/sources/pitch carried from read); metadata-only (body unchanged, GET then PUT); metadata override (title/tags/pitch from args); pitch carried when omitted; 404 read; PUT non-ok surfaces beacon error; partial diff ⇒ PUT partial + error surfaced; pure-insertion diff with one context line appends (the documented append recipe).
- `drone-agent/test/swarm-tool-input-validation.test.ts` — add `wiki_edit` cases to the `it.each` rejected-input matrix and assert `fetchMock` not called.

Depends on: Steps 1,3.

### Phase D — coordinator assets
**Step 9** `drone-coordinator/src/default-assets.ts`:
- `WIKI_LIBRARIAN_SYSTEM_PROMPT` tools array: add `- swarm__wiki_edit`.
- "Your Tools" wiki bullet: name `swarm__wiki_edit` alongside read/write.
- Exclusion list (near `!swarm__wiki_write` / `!swarm__wiki_delete`): add `- !swarm__wiki_edit`.
- `MEMORY_WIKI_SKILL_BODY` exploration + ingestion workflow: add `swarm__wiki_edit` for surgical edits of existing pages.

**Step 10** `drone-coordinator/src/db/init.ts` — `BUILTIN_HIDDEN_TOOLS`: add `{ name: 'swarm__wiki_edit', description: 'Surgically edit an existing wiki page body and/or metadata' }`.

**Step 11** `drone-coordinator/test/default-assets.test.ts` — assert librarian system prompt contains `swarm__wiki_edit` (mirror the existing `swarm__wiki_write` assertion at line ~69).

Depends on: Step 6 (tool exists).

### Phase E — ADR + docs
**Step 12** Write `docs/adr/265-optional-hunk-header-and-swarm-wiki-edit.md` (Context: recurring "no hunks found" pain + wiki full-rewrite fallbacks; Decision: headerless-parse fallback + agent-side wiki_edit with optional diff/metadata; Consequences: headerless single-hunk, bare-`@@ label` now context, agent-side no server routes, D7 pitch-clear wart). Add row to `docs/adr/index.md`.

Depends on: everything above (documents final state).

### Phase F — validation (FINAL STEP, must be last)
**Step 13** Verification gate. See Validation Criteria.

## Validation criteria (all must pass)
1. LSP: zero errors/warnings on every touched file (`drone-agent/src/shared/unified-diff-parser.ts`, `drone-agent/src/shared/patch-applier/errors.ts`, `drone-agent/src/plugins/file.ts`, `drone-agent/src/plugins/swarm/tools-wiki.ts`, `drone-agent/src/plugins/swarm/index.ts`, coordinator files, all new test files).
2. `pnpm -r run build` passes (drone-core types unchanged; still run per AGENTS.md dependency rule).
3. `pnpm typecheck` passes.
4. `pnpm run lint` passes (eslint + prettier; expect prettier to reformat edited files — re-read before further edits).
5. Fast suite `pnpm test` passes, including: new parser tests, new file apply-diff tests, new wiki-edit tests, extended input-validation matrix, coordinator default-assets test. (Slow suite at implementer's discretion.)
6. Behavioral spot-checks:
   - headerless patch to a real file applies via `file__apply_diff`.
   - `wiki_edit` with only `diff` PUTs a patched body and preserves title/tags/sources/pitch.
   - `wiki_edit` with only `pitch` PUTs unchanged body + new pitch.
   - `wiki_edit` with no diff and no metadata field errors without any fetch.
7. No dead code: the local `formatPatchError` copy is removed from file.ts after extraction.
8. ADR 265 exists; `docs/adr/index.md` has its row.
