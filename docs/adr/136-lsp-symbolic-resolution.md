---
tags: [decision, lsp, ergonomics, position-resolution]
related: [concepts/lsp-symbolic-resolution.md, decisions/069-lsp-ergonomics.md, decisions/138-lsp-symbolic-resolution-round-2.md, modules/drone-core.md, modules/drone-agent-plugins.md]
---

# 136: LSP Symbolic Resolution — surroundingText, Auto-Expansion & Reference IDs

**Status**: Implemented (2026-08-17)

> **Superseded in part by [[decisions/138-lsp-symbolic-resolution-round-2]]** — the `suggestedSurroundingText` field was renamed to `suggestedContext` (now a dense context block), the filter was changed to exact-match (trim-only) sized to the handed-back block, the reference cache gained a cap + TTL + staleness detection, `code_action` referenceId now targets `ref.filePath`, and `get_diagnostics` became file/severity-only.

## Context

The prior LSP ergonomics work (decision 069) introduced `text`/`symbol` position resolution as an alternative to line/column coordinates. However, ambiguity handling was weak: when a lookup matched multiple positions, the tool threw a plain `Error` with positions baked into a formatted string — making it impossible for the LLM to pick a target programmatically.

Additionally, navigation and inspection tools returned only raw coordinates, forcing the LLM to re-read files to understand what a result actually was.

A code review of the initial implementation found 7 issues — most critically, `storeReferences` was never called from any tool, making the `referenceId` parameter on `rename`/`code_action` permanently non-functional.

## Decision

### 1. Generic `AmbiguousPositionError` in `drone-core`

Created `drone-core/src/position-types.ts` — a **generic, non-LSP-specific** module (other tools may reuse it for text/symbol position resolution):

- `AmbiguousMatch` — structured match data: `{ filePath, line, column, context, suggestedSurroundingText }`
- `AmbiguousPositionError` — error class carrying `filePath` (or `undefined` for workspace ambiguity) and `matches: AmbiguousMatch[]`
- `buildAmbiguousMatches()` — async helper that computes context windows and suggested surrounding text
- `suggestSurroundingText` — finds the shortest context line unique to one match vs. all others. Line-level granularity (like `file__apply_diff`'s reworked hunks). Expands from a 5-line soft limit up to a 30-line hard limit in 5-line steps. Returns `undefined` when no unique line exists within the hard limit.

### 2. Reference ID handshake wired up

The "Resolve → Confirm → Execute" handshake now actually works:

- `resolveTextPosition` and `resolveSymbolPosition` throw `AmbiguousPositionError` (instead of plain `Error`) when a lookup is ambiguous
- `rename` and `code_action` catch the error, call `storeReferences()` to get reference IDs, and return a crib sheet containing:
  - `referenceId` for each match
  - Line/column position
  - Code snippet (via `readFileSnippet`)
  - `suggestedSurroundingText` (minimal unique context line)
  - Surrounding context text
- The LLM re-invokes with a `referenceId` to confirm the target, which resolves via the session-scoped reference cache

### 3. `surroundingText` applies to workspace symbols

`resolveSymbolPosition` now applies `surroundingText` filtering to workspace symbol matches — each match's file is read and its context lines checked for the surrounding text. This works across files since each workspace symbol carries its own `filePath`.

### 4. Auto-expansion fixes

- `buildAutoExpansion` deduplicates by location key (`filePath:line:column`), not by file — multiple references in the same file now each get snippets
- `completion` tool now returns a query-position snippet (same pattern as `inspect`)
- `readFileSnippet` `column` parameter removed (was dead code — snippets are line-oriented)

### 5. Stale document state fix

Added `server.refreshIfNeeded()` to `go_to`, `inspect`, `completion`, and `call_hierarchy` (previously only `find_references`, `symbols`, `code_action`, and `formatting` called it).

### 6. Diagnostics schema cleanup

Removed `surroundingText` from the diagnostics tool schema — whole-file granularity is the right level for diagnostics filtering.

## Consequences

### Positive

- The reference ID handshake is now functional end-to-end: ambiguity → reference IDs + crib sheet → confirm → execute
- `suggestedSurroundingText` gives the LLM a minimal unique line it can use to disambiguate via `surroundingText` on retry, without needing to read the whole file
- `AmbiguousPositionError` is in `drone-core` and reusable by any future tool that resolves text/symbol positions
- Workspace symbol ambiguity now supports `surroundingText` disambiguation across files
- Code snippets are consistently returned for small result sets across navigation, inspection, and completion tools

### Negative

- `buildAmbiguousMatches` is async (per-match file reads for workspace symbols) — a minor cost only paid on the ambiguity path
- `server.ts` is now ~1,580 lines (above the 1000-line split threshold) — a future refactor should split position resolution into its own module

### Technical notes

- The `AmbiguousPositionError` carries structured data; tools use `instanceof` to detect it (not string matching)
- Reference IDs are `ref_1`, `ref_2`, ... stored in a session-scoped `Map<string, location>` on the `ServerManager`
- `suggestedSurroundingText` uses line-level granularity (trimmed line equality) — a line unique to one match's context window is the suggestion

## Files Modified

| File | Changes |
|------|---------|
| `drone-core/src/position-types.ts` | **New** — `AmbiguousMatch`, `AmbiguousPositionError`, `buildAmbiguousMatches`, `suggestSurroundingText` |
| `drone-core/src/index.ts` | Re-export position types |
| `drone-agent/src/plugins/lsp/server.ts` | Throw `AmbiguousPositionError`; apply `surroundingText` to workspace symbols; remove `column` from `readFileSnippet` |
| `drone-agent/src/plugins/lsp/tools/editing.ts` | Catch `AmbiguousPositionError`, call `storeReferences`, return crib sheets |
| `drone-agent/src/plugins/lsp/tools/navigation.ts` | Fix `buildAutoExpansion` dedup; add `refreshIfNeeded` to `go_to` |
| `drone-agent/src/plugins/lsp/tools/completion.ts` | Add `refreshIfNeeded` + snippet to `completion`; `refreshIfNeeded` to `inspect` |
| `drone-agent/src/plugins/lsp/tools/hierarchy.ts` | Add `refreshIfNeeded` to `call_hierarchy` |
| `drone-agent/src/plugins/lsp/tools/diagnostics.ts` | Remove `surroundingText` from schema |
| `drone-agent/test/lsp-ergonomics.test.ts` | 34 tests (AmbiguousPositionError, reference IDs, suggestedSurroundingText, completion snippet, diagnostics schema, mock updates) |

## Related

- [[concepts/lsp-symbolic-resolution]] — The original plan this decision implements
- [[decisions/069-lsp-ergonomics]] — Prior LSP ergonomics (text/symbol resolution)
- [[modules/drone-core]] — Position types live in drone-core
- [[modules/drone-agent-plugins]] — LSP plugin
