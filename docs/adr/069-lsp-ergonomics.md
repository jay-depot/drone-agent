---
tags: [decision, lsp, ergonomics]
related: [modules/drone-agent-plugins.md, decisions/048-large-file-splitting.md]
---

# 069: LSP Ergonomics for LLM

**Status**: Implemented (2026-07-14)

## Context

The LSP plugin's tools required the LLM to know exact 1-based line/column numbers for every cursor-position operation (hover, go-to-definition, find-references, etc.). This forced the LLM to either remember positions from a recent file read or manually count characters — a significant ergonomic friction point.

Additionally, several other pain points existed:

- **No "find by text content" flow** — The LLM couldn't say "find `function foo` and hover over it" in one step
- **No didChange for unsaved buffers** — If the LLM wrote to a file via `file__write`, the LSP server still saw the old content
- **rename returned edits instead of applying** — The LLM had to parse workspace edits and make individual file writes
- **code_action required a range** — The LLM had to specify exact start/end positions
- **formatting returned truncated edits** — The LLM had to manually apply formatting changes

## Decision

### Text/symbol resolution

Add optional `text` and `symbol` parameters to all cursor-position tools as alternatives to `line`/`column`. The `ServerManager` resolves these to positions:

- **`text`**: Searches file content for the text snippet. Exact match (case-sensitive) first, fallback to case-insensitive. On ambiguity, throws an error listing each position with 2 lines of context around it.
- **`symbol`**: Tries `textDocument/documentSymbol` first, falls back to `workspace/symbol`. Same ambiguity/not-found error format.

### Unsaved buffer handling

Sync the file from disk before every LSP tool call via `syncFileIfNeeded()`. This ensures that if the LLM wrote to a file in the same turn, the LSP server sees the latest content.

### Rename auto-apply

Add an optional `apply` boolean parameter (default `false`). When `true`, the tool applies the workspace edit directly and returns a summary. When `false` (or omitted), it returns the edit as JSON (backward compatible).

### Code action range relaxation

Allow omitting the range entirely — returns all code actions for the file. When `text` or `symbol` is provided, auto-resolve the range and find overlapping diagnostics.

### Formatting auto-apply

Always apply formatting edits directly. Returns a summary instead of raw edit JSON.

### Tool descriptions

All modified tools' descriptions updated to mention the new capabilities.

## Consequences

### Positive

- The LLM can now use `{filePath, text}` or `{filePath, symbol}` instead of `{filePath, line, column}` for all 14 cursor-position tools
- Rename can be applied in one call with `apply: true`
- Formatting is applied automatically
- Code actions can be requested without specifying a range
- Diagnostics can be targeted to a specific position via text/symbol
- Unsaved buffers are synced before every LSP tool call
- Backward compatible — all existing `{filePath, line, column}` calls continue to work

### Negative

- `parsePositionInput` became async, which rippled through all 14 cursor-position tools
- `NormalizedSymbol.line` and `NormalizedSymbol.column` are optional, requiring type-narrowing filters in `resolveSymbolPosition`

### Technical notes

- `resolveTextPosition` reads the file from disk using the existing `readDocumentSnapshot` helper — no new file I/O infrastructure needed
- `resolveSymbolPosition` makes two LSP requests in the worst case (document symbols + workspace symbol), which could be slow for large files
- The `syncFileIfNeeded` method only syncs files that are already open in the LSP server — files not yet opened are handled by `ensureDocumentLoaded`

## Files Modified

| File                                               | Changes                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `drone-core/src/lsp-types.ts`                      | JSDoc comments for 0-based vs 1-based                                                                                              |
| `drone-agent/src/plugins/lsp/server.ts`            | Added `resolveTextPosition`, `resolveSymbolPosition`, `syncFileIfNeeded`; made `parsePositionInput` async with text/symbol support |
| `drone-agent/src/plugins/lsp/tools/navigation.ts`  | Added text/symbol params to 5 tools                                                                                                |
| `drone-agent/src/plugins/lsp/tools/editing.ts`     | Added text/symbol to code_action + rename; added `apply` to rename; auto-apply formatting                                          |
| `drone-agent/src/plugins/lsp/tools/completion.ts`  | Added text/symbol params to 2 tools                                                                                                |
| `drone-agent/src/plugins/lsp/tools/hierarchy.ts`   | Added text/symbol params to 2 tools                                                                                                |
| `drone-agent/src/plugins/lsp/tools/diagnostics.ts` | Added text/symbol params                                                                                                           |
| `drone-agent/test/lsp-ergonomics.test.ts`          | 21 new tests                                                                                                                       |

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — LSP plugin entry
- [048-large-file-splitting](048-large-file-splitting.md) — LSP server.ts and tools.ts were split in that refactor
