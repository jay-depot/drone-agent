---
key: plan-lsp-symbolic-resolution-improvements
tags:
  - completed
  - lsp
  - symbolic-resolution
created: 2026-08-14T00:00:45.935Z
updated: 2026-08-17T04:41:44.420Z
---

# Plan: Improve LSP Symbolic Resolution & Accessibility

## Summary

Address the "Coordinate Tax" in LSP navigation and editing tools. Currently, while we do have symbol lookup in LSP tools, in practice the agent must rely on precise line/column numbers to disambiguate, which leads to high friction, hallucinations, and a low retry rate when multiple symbols match. This plan introduces a "Semantic Bridge" that replaces coordinate math with anchor-based resolution and simplified pointers.

## Goal

Give the LLM reliable ways to unambiguously identify symbols to the LSP tools without requiring exact line/column coordinates. The approaches we have chosen to implement are:

1. **Contextual Symbol Resolution (The "Anchor" Pattern)**: Allow the agent to specify a symbol by its surrounding context (e.g., "the `id` field inside the `User` class") rather than by line/column coordinates. This is a universal capability applied to all LSP tools using symbolic resolution.
2. **Auto-Expansion for Navigation & Inspection**: When a symbol lookup returns a small number of matches, automatically return code snippets for all matches. This should apply to `go_to`, `find_references`, `inspect`, and `completion`.
3. **Reference IDs for Destructive Edits**: Introduce a "Resolve → Confirm → Execute" handshake for destructive edits (rename, code action) to prevent accidental workspace corruption. The agent can resolve a symbol to a list of `Reference IDs` and then confirm which one to act on, rather than relying on line/column coordinates.

## Implementation Steps

### 1. Implement Contextual Symbol Resolution (The "Anchor" Pattern) ✅ DONE

- Fixed broken `resolveTextPosition`/`resolveTextPositionWithContext` code in server.ts
- Consolidated into single `resolveTextPosition` with optional `surroundingText` parameter
- Updated `resolveSymbolPosition` to accept `surroundingText` for disambiguation
- Updated `parsePositionInput` and `resolveAtPosition` to pass `surroundingText` through
- Added `surroundingText` to all LSP tool schemas (navigation, editing, completion, hierarchy, diagnostics)
- All LSP tools now support `surroundingText` for disambiguation

### 2. Implement Auto-Expansion for Navigation & Inspection ✅ DONE

- Added `readFileSnippet` method to `ServerManager` for reading code context around positions
- `go_to` and `find_references` now include `snippets` field for ≤5 results
- `inspect` now includes a `snippet` field showing code context around the inspected position
- `completion` returns snippets for small result sets (≤5 items with position info)

### 3. Implement Reference IDs for Destructive Edits ✅ DONE

- Added reference ID cache (`storeReferences`, `resolveReference`) to `ServerManager`
- `rename` and `code_action` tools now accept `referenceId` parameter
- When `referenceId` is provided, it resolves to cached coordinates instead of position resolution

### 4. Refine Tool Descriptions & Response Formatting ✅ DONE

- Updated all tool descriptions to mention `surroundingText`, `snippet`, and `referenceId` features
- Added `surroundingText` property to diagnostics tool schema
- Updated `call_hierarchy` description to mention `surroundingText`

## Validation Results ✅ ALL PASSED

- [x] `lsp__go_to`, `lsp__find_references`, `lsp__inspect` return code snippets for small result sets
- [x] `lsp__rename` and `lsp__code_action` accept `referenceId` parameter
- [x] Symbolic lookup with `surroundingText` correctly identifies the target symbol among multiple matches
- [x] `pnpm -r run lint` and `pnpm -r run build` pass
- [x] All 29 LSP ergonomics tests pass (including new surroundingText, reference ID, and snippet tests)
- [x] Reference ID storage and retrieval works correctly
- [x] `readFileSnippet` returns code context and handles missing files gracefully
