---
key: plan-lsp-symbolic-resolution-improvements
tags:
  []
created: 2026-08-14T00:00:45.935Z
updated: 2026-08-14T00:20:38.598Z
---

# Plan: Improve LSP Symbolic Resolution & Accessibility

## Summary
Address the "Coordinate Tax" in LSP navigation and editing tools. Currently, while we do have symbol lookup in LSP tools, in practice the agent must rely on precise line/column numbers to disambiguate, which leads to high friction, hallucinations, and a low retry rate when multiple symbols match. This plan introduces a "Semantic Bridge" that replaces coordinate math with anchor-based resolution and simplified pointers.

## Goal
Give the LLM reliable ways to unambiguously identify symbols to the LSP tools without requiring exact line/column coordinates. The approaches we have chosen to implement are:

1. **Contextual Symbol Resolution (The "Anchor" Pattern)**: Allow the agent to specify a symbol by its surrounding context (e.g., "the `id` field inside the `User` class") rather than by line/column coordinates. This is a universal capability applied to all LSP tools using symbolic resolution.
2. **Auto-Expansion for Navigation & Inspection**: When a symbol lookup returns a small number of matches, automatically return code snippets for all matches. This should apply to `go_to`, `find_references`, `inspect`, and `completion`.
3. **Reference IDs for Destructive Edits**: Introduce a "Resolve $\rightarrow Confirm $\rightarrow$ Execute" handshake for destructive edits (rename, code action) to prevent accidental workspace corruption. The agent can resolve a symbol to a list of `Reference IDs` and then confirm which one to act on, rather than relying on line/column coordinates.

## Implementation Steps

### 1. Implement Contextual Symbol Resolution (The "Anchor" Pattern)
- **Target:** `POSITION_PROPERTIES` in `drone-agent/src/plugins/lsp/tools/navigation.ts` and `editing.ts`, and the `server.resolveAtPosition` method in `drone-agent/src/plugins/lsp/server.ts`.
- **Change:** Add a `surroundingText` (or `context`) optional property to the `POSITION_PROPERTIES` input schema.
- **Logic:** 
  - Centralize the resolution logic in `server.resolveAtPosition` so it applies to all tools using this method.
  - **Pass 1:** Find all occurrences of the `symbol` or `text` in the file.
  - **Pass 2:** If `surroundingText` is provided, filter matches by searching for that text in the lines immediately preceding/following the match (similar to the `file__apply_diff` fuzzing logic).
- **Benefit:** Universal ability for any LSP tool to target a symbol by its environment rather than guessing a line number.

### 2. Implement Auto-Expansion for Navigation & Inspection
- **Target:** `createGoToTool`, `createFindReferencesTool` in `navigation.ts`, and `createInspectTool`, `createCompletionTool` in `tools/index.ts` (or respective files).
- **Change:** When the number of resolved locations is small (e.g., $\le 5$), the tool should automatically fetch and return code snippets for all matches.
- **Logic:** 
  - Instead of returning just coordinates, use internal read logic to extract a window of code (e.g., 5 lines around the match).
  - Return these snippets directly in the response.

### 3. Implement Reference IDs for Destructive Edits
- **Target:** `createRenameTool` and `createCodeActionTool` in `editing.ts`.
- **Change:** Introduce a "Resolve $\rightarrow$ Confirm $\rightarrow$ Execute" handshake to prevent accidental workspace corruption.
- **Logic:**
  - **Resolution Phase:** When a symbol lookup returns multiple matches, return them as a list of `Reference IDs` (e.g., `ref_1`, `ref_2`) paired with code snippets.
  - **Execution Phase:** Update the `rename` and `code_action` tools to accept a `referenceId` as a valid target.
  - **Mapping:** Store the mapping of `referenceId` $\rightarrow$ `coordinates` in a session-scoped cache.

### 4. Refine Tool Descriptions & Response Formatting
- **Target:** All LSP tool definitions.
- **Change:** Update descriptions to encourage the use of `surroundingText` for ambiguity resolution and to explain the `Reference ID` system.

## Validation Criteria
- [ ] `lsp__go_to`, `lsp__find_references`, `lsp__inspect`, and `lsp__completion` return actual code snippets for small result sets.
- [ ] `lsp__rename` can be executed using a `referenceId` generated from a previous resolution call.
- [ ] Symbolic lookup with `surroundingText` correctly identifies the target symbol among multiple matches across different LSP tools.
- [ ] `pnpm -r run lint` and `pnpm -r run build` pass.
- [ ] LSP diagnostics for the plugin remain clean.