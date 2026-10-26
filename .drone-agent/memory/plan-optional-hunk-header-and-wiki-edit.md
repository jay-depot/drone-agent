---
key: plan-optional-hunk-header-and-wiki-edit
tags:
  - plan
  - file-plugin
  - swarm-plugin
  - wiki
  - diff-format
created: 2026-10-26T22:54:22.123Z
updated: 2026-10-26T23:13:03.937Z
---

# PLAN: Optional `@@` hunk header in `file__apply_diff` + new `swarm__wiki_edit` tool

Status: **EXECUTED / COMPLETE** (2026-10-26, branch `feat/more-diff-improvements`)

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
**Step 1** `drone-agent/src/shared/unified-diff-parser.ts` — headerless fallback after the header loop: if `hunks.length === 0`, `classifyBody(lines, 0, '')` and push only if `oldLines.length > 0 || newLines.length > 0`. Side benefit: bare `@@ ## label` now parses as context.
**Step 2** `drone-agent/test/unified-diff-parser.test.ts` — new describe block "headerless diffs".
**Step 3** Extract `formatPatchError` into `drone-agent/src/shared/patch-applier/errors.ts` as an export; `file.ts` imports it, local copy removed, unused `PatchError` import dropped.

### Phase B — file__apply_diff headerless
**Step 4** `drone-agent/src/plugins/file.ts` — tool/patch descriptions + "no hunks found" error reworded (header OPTIONAL; must contain `-`/`+` change lines); version 0.4.0→0.5.0.
**Step 5** `drone-agent/test/file/apply-diff.test.ts` — headerless single-line replace + headerless multi-change body.

### Phase C — swarm__wiki_edit
**Step 6** `drone-agent/src/plugins/swarm/tools-wiki.ts` — `createWikiEditTool(ctx)` + append to `createWikiTools`. Imports: `withKeyLock` from `drone-swarm-common` (root), `parseUnifiedDiff`, `applyPatch`, `renderDiffV2`, `formatPatchError`.
**Step 7** `drone-agent/src/plugins/swarm/index.ts` — swarm version 0.2.0→0.3.0.
**Step 8** NEW `drone-agent/test/swarm/wiki-edit.test.ts` + `wiki_edit` cases in `drone-agent/test/swarm-tool-input-validation.test.ts`.

### Phase D — coordinator assets
**Step 9** `drone-coordinator/src/default-assets.ts` — librarian allowlist + "Your Tools" bullet + `!swarm__wiki_edit` exclusion + `MEMORY_WIKI_SKILL_BODY` exploration/ingestion.
**Step 10** `drone-coordinator/src/db/init.ts` — `BUILTIN_HIDDEN_TOOLS` entry.
**Step 11** `drone-coordinator/test/default-assets.test.ts` — assert librarian prompt contains `swarm__wiki_edit`.

### Phase E — ADR + docs
**Step 12** `docs/adr/265-optional-hunk-header-and-swarm-wiki-edit.md` + row in `docs/adr/index.md`.

### Phase F — validation (FINAL)
**Step 13** Verification gate.

---
## COMPLETION SUMMARY (appended 2026-10-26)

All 13 steps executed. Branch `feat/more-diff-improvements`.

**Delivered:**
- `unified-diff-parser.ts`: headerless fallback — no `@@` header ⇒ one `classifyBody(lines, 0, '')` hunk, pushed only when it has `-`/`+` lines (garbage stays `[]`); bare `@@ ## label` now context.
- `shared/patch-applier/errors.ts`: `formatPatchError` extracted/exported; `plugins/file.ts` imports it (local copy + unused `PatchError` import removed — no dead code).
- `plugins/file.ts`: descriptions + "no hunks found" error reworded for the optional header; version 0.5.0.
- `plugins/swarm/tools-wiki.ts`: new `createWikiEditTool` — validate → `withKeyLock('wiki:'+pageId)` → GET scoped page (404 → not-found) → optional diff apply (0 hunks applied ⇒ error, no write; partial ⇒ PUT partial then surface failures) → PUT carried/overridden fields → success `{ page, summary, diff? }`. `swarm/index.ts` version 0.3.0.
- Coordinator: librarian allowlist + "Your Tools" bullet + `!swarm__wiki_edit` exclusion + memory-wiki skill exploration/ingestion; `BUILTIN_HIDDEN_TOOLS` entry.
- Tests: parser headerless block; file headerless apply tests; NEW `test/swarm/wiki-edit.test.ts` (10 cases); `wiki_edit` no-change matrix (own `it.each`, since its error is not the "non-empty <field>" template); librarian prompt assertion; swarm tool-count 13→14 in `swarm-spawn.test.ts`.
- `docs/adr/265-optional-hunk-header-and-swarm-wiki-edit.md` + index row.

**Validation (all pass):** LSP clean on every touched file; `pnpm -r run build` ✓; `pnpm typecheck` ✓; `pnpm run lint` ✓ (fixed a `no-explicit-any` in tools-wiki.ts); `pnpm test` → 4511 passed / 16 skipped / 0 failed; behavioral spot-checks on built dist (headerless parses as 1 hunk + applies, bare `@@` = context, garbage ⇒ 0 hunks); no dead code.

**Deviations/notes:**
- The input-validation matrix could not absorb `wiki_edit` (its error is "requires at least one change", not "requires a non-empty <field>"); used a sibling `it.each`.
- Extra hidden dependency found + fixed: `swarm-spawn.test.ts` pins the swarm tool count (13→14).
- Prettier reformatted touched files after lint; re-read before further edits.
