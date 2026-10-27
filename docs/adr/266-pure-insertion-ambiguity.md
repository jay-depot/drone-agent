# ADR 266: Pure-insertion hunks fail loudly when the anchor is ambiguous

**Status**: Accepted (2026-10-27, branch `fix/apply-diff-insertion-anchor`)

**Amends**: [265-optional-hunk-header-and-swarm-wiki-edit](265-optional-hunk-header-and-swarm-wiki-edit.md) — reverses its "bare `@@ ## label` parses as context" side benefit for column-0 lines.

## Context

`file__apply_diff` (and everything built on the shared patch-applier: `swarm__wiki_edit`, the memory/notepad edit actions) mishandled **pure-insertion hunks** — hunks whose change zone has only `+` lines, so `oldLines` is empty. With nothing to search for, the applier locates the insertion point from surrounding context via `locatePureInsertion`, which **returned the first match it found** and never checked whether that match was unique.

Every other hunk kind guards against this: when more than one match survives narrowing, `applyPatch` raises a Type 1 failure (cheat sheet of each candidate) instead of guessing. Pure insertion skipped that guard entirely, so an ambiguous anchor inserted lines **at the wrong location while reporting `success: true`**.

This was reachable with **well-formed input** — a malformed patch was not required:

- A hunk whose only anchor is a **generic `contextAfter`** (e.g. `};`) inserts before the _first_ `};` in the file.
- A hunk whose `contextBefore` line is **duplicated** inserts after the _first_ occurrence.
- A **column-0 malformed `@@` line** (e.g. a bare `@@`, or `@@ ## label` with no `-N,M +N,M`) was not matched by the hunk-header regex, so it was ingested as a **content line** (`@`), which poisoned `contextBefore` into a never-matching block and fell through to the generic `contextAfter` path.

The third case is the one observed in the wild: an agent's patch began with a stray `@@`, the `@` was absorbed into the anchor, and the inserted lines landed in a neighbouring type declaration instead of the intended one — with a success response.

A secondary defect surfaced while building the fix: the Type 1 cheat sheet's `buildReworkedHunk` decided "is this candidate unique?" by comparing **absolute line coordinates**. Two distinct candidates always differ in coordinates, so the loop that grows extra context never ran, and the "reworked hunk to target this match" was **byte-identical for every candidate** — useless for the crib-and-resubmit workflow the cheat sheet exists to serve.

## Decision

### 1. `locatePureInsertion` → `locatePureInsertionCandidates`

In `drone-agent/src/shared/patch-applier/matching.ts`, the locator now returns **all distinct insertion indices**, using the first anchor strategy that yields any:

1. `contextBefore` — insertion immediately _after_ each matching block.
2. `contextAfter` — insertion immediately _before_ each matching block.
3. no context — `[0]` for an empty file, else the line hint, else `[]`.

Matching still loosens through fuzz levels (exact → trim → strip-all) but stops at the first level that yields any candidates, so a partial match does not pull in unrelated levels.

### 2. Ambiguity fails loudly

In `patch-applier.ts`, the pure-insertion branch now interprets the candidate list:

- **0 candidates** → Type 2 failure (not found), as before.
- **1 candidate** → apply.
- **>1 candidates** → new `buildInsertionAmbiguityFailure` in `errors.ts`: a `type1` failure whose message is `Ambiguous insertion point (N candidates)` and whose cheat sheet lists every candidate. Each candidate is a **zero-width span** at its insertion index, so `buildMatchSites` renders the surrounding context plus a reworked hunk that _inserts at that point_.

Nothing is written on ambiguity — the correct behaviour, and consistent with every other ambiguous hunk.

### 3. Cheat sheet grows real context

`buildReworkedHunk`'s uniqueness test now compares the **rendered window text** of each candidate instead of its coordinates. The growth loop therefore adds context lines until each candidate's window is textually distinct, so the reworked hunks actually differ and resubmitting one disambiguates. This is the context-first enrichment the cheat sheet is supposed to provide.

### 4. Column-0 `@@`-prefixed lines are skipped, not ingested

In `unified-diff-parser.ts`, `classifyBody` now **skips** any line whose first character is `@` (in both the change-zone loop and the no-change context-only branch). Such a line is a malformed hunk header — a bare `@@`, or a `@@` with only a section label — and ingesting it as content silently corrupts the anchor. Valid `@@ -N,M +N,M @@` headers are already consumed by the parser loop before `classifyBody` runs, so only malformed ones reach this filter.

**This reverses ADR 265's "side benefit".** ADR 265 claimed a bare `@@ ## label` line "is no longer mistaken for a header — it becomes a context line". It does become a context line — and that is the bug: it poisons the anchor. A patch that genuinely carries such text as content must keep it (the existing parser test asserts a _leading-space_ ` @@ ## label` is context — that still holds, since only a column-0 `@` is filtered).

## Consequences

- A pure-insertion hunk with a non-unique anchor fails with an actionable cheat sheet instead of silently writing to the wrong place.
- A stray column-0 `@@` line in a patch can no longer corrupt the surrounding anchor; it is dropped.
- Cheat-sheet reworked hunks are now genuinely distinct per candidate (previously identical), improving every Type 1 failure, not just insertion.
- Behaviour change: patches that _relied_ on "insert at the first generic `};`" now fail. This is intended — the previous behaviour was silent misplacement.
- The `file` plugin version bumps 0.5.0 → 0.6.0.

Out of scope (distinct mechanisms in the same family, tracked separately): the `maxFuzz: 200` "applied by fuzzy guess" corruption of long markdown lines, and marker-anchored splices done outside the patch tool.
