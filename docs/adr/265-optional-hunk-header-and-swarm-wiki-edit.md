# ADR 265: Optional `@@` hunk header + agent-side `swarm__wiki_edit`

**Status**: Accepted (2026-10-26, branch `feat/more-diff-improvements`)

## Context

Two coupled pains, both rooted in the unified-diff format the agent uses to edit text.

1. **`file__apply_diff` rejected headerless patches.** The parser only collected hunks when it saw a `@@ -N,M +N,M @@` header. Yet the engine treats every header field as _advisory_ — `lineHint` is a soft tie-break, `sectionHeading` is a soft anchor, and matching is content-anchored regardless. So a hand-written patch that omitted the header (or used a bare `@@ ## label` line as the header) failed with "no hunks found in the patch string" even though the change lines were unambiguous. The swarm wiki `drone-agent-file-apply-diff-parameter-name-and-hunk-headers` documents three recurrences of exactly this.

2. **Editing an existing wiki page required a full rewrite.** The swarm wiki tooling offered `wiki_write` (create-or-replace the whole page) but no way to change one block or one metadata field. The `coordinator-wiki-librarian` persona therefore fell back to read-the-whole-page → `wiki_write`-the-whole-page for a one-line fix — wasteful, and prone to clobbering concurrent edits (documented in the swarm wiki `wiki-tooling-notes`).

## Decision

### 1. Headerless patches parse as exactly one hunk

In `drone-agent/src/shared/unified-diff-parser.ts`, after the header-collecting loop, if no hunks were found the whole input is classified as ONE hunk via the existing `classifyBody(lines, 0, '')` — `lineHint` and `sectionHeading` stay undefined, matching the advisory semantics already in force. The hunk is pushed only when it contains actual `-`/`+` change lines, so genuinely garbage input (e.g. a bare sentence) still yields `[]` and the caller's "no hunks found" error stays accurate.

Side benefit: a bare `@@ ## label` line is no longer mistaken for a header — it becomes a context line in the single headerless hunk.

The `file__apply_diff` tool description, `patch` parameter description, and "no hunks found" error text are reworded to state the header is OPTIONAL and that a headerless patch must contain `-`/`+` change lines. The `file` plugin version bumps 0.4.0 → 0.5.0.

### 2. `swarm__wiki_edit` — agent-side surgical wiki editing

A new tool in `drone-agent/src/plugins/swarm/tools-wiki.ts` applies the SAME diff format to a wiki page body and/or updates metadata fields.

- **Inputs:** `pageId` (required), `scope`, `diff`, `title`, `tags`, `sources`, `pitch`; `additionalProperties: false`. Validation: `pageId` non-empty AND at least one of `diff`/`title`/`tags`/`sources`/`pitch` present, else the tool errors without any network call. `diff` is optional — the tool doubles as a field-level editor.
- **Default scope `beacon`**, mirroring `wiki_write`.
- **Agent-side application, no server route (D6):** reuse the existing beacon `GET /wiki/:id?scope=` and `PUT /wiki/:id`. No beacon or coordinator route changes. `drone-agent` owns the diff parsing and application, so the shared parser/applier/renderer are reused directly.
- **Concurrency (D4):** the whole read → patch → PUT span runs inside `withKeyLock('wiki:' + pageId)` (the ADR 237 pattern), so parallel edits to the same page serialize instead of corrupting each other.
- **Partial success (D2):** matches `file__apply_diff` — successful hunks are applied, the partial result is PUT, then the hunk failures are surfaced in the returned error (noting the page was written). Zero applied hunks writes nothing and errors.
- **Metadata defaults (D7):** `title`/`tags`/`sources`/`pitch` default to the values read from the page. Known wart, accepted: an empty `pitch` is not transmitted by the PUT path (`wiki_write` sends `pitch` only when truthy), so _clearing_ a pitch remains a `wiki_write` job.
- The tool is wired into the librarian tooling: the `coordinator-wiki-librarian` persona allowlist, its "Your Tools" bullet, the `memory-wiki` skill's exploration + ingestion workflow, the coordinator `BUILTIN_HIDDEN_TOOLS` seed, and the admin persona's `!` exclusion list. The `swarm` plugin version bumps 0.2.0 → 0.3.0.

`formatPatchError` — previously private in `plugins/file.ts` — is extracted to `shared/patch-applier/errors.ts` as an export so both `file__apply_diff` and `wiki_edit` share one failure formatter (the local copy in `file.ts` is removed).

The naming-convention split between `file__*` and `swarm__wiki_*` is unchanged and explicitly out of scope.

## Consequences

- Hand-written patches no longer need a `@@` header; a headerless patch is one content-anchored hunk.
- A bare `@@ ## label` body line now parses as context rather than being dropped.
- `must contain -/+ change lines` is the new rejection floor for genuinely empty/garbage patches.
- Wiki page edits are surgical and serialized, removing the read-all/write-all fallback and the parallel-edit corruption window.
- No beacon/coordinator route changes; the whole feature is agent-side.
- Clearing a `pitch` still requires `wiki_write` (documented wart).
