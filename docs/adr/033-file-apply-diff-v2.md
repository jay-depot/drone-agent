---
tags: [decision]
related:
  [
    drone-agent-plugins.md,
    028-tool-name-separator.md,
    038-file-apply-diff-unified-diff.md,
  ]
---

# 033: Content-Anchor-Based Patch Format for `file__apply_diff`

**Status**: Superseded by [038-file-apply-diff-unified-diff](038-file-apply-diff-unified-diff.md) (2026-07-01)

**Note**: This ADR is superseded. The nested JSON hunk format was replaced with a flat unified diff string in ADR 038 because LLMs produced malformed nested JSON more often than valid unified diff strings. The content-anchor matching engine (`patch-applier.ts`) and the 3-level fuzzy matching cascade were preserved — only the input format changed.

## Context

The `file__apply_diff` tool used **line numbers** (`startLine`) as the primary location mechanism, with exact-string-match verification of `oldLines`. This was fragile — LLMs are notoriously bad at counting lines, and a single line added or removed above the edit point invalidated every subsequent hunk. The tool also provided poor error feedback when verification failed, making self-correction difficult.

## Decision

Replace line numbers with a **content-anchor-based patch format** inspired by OpenAI's V4A diff format. Each hunk is located by matching context lines in the file, not by counting lines.

Key design choices:

1. **Content anchors over line numbers**: The `anchors` field contains code lines that uniquely identify the location (e.g., `["class Foo:", "    def bar():" ]`). Multiple anchors provide hierarchical disambiguation for nested scopes.

2. **Context lines for verification**: `contextBefore` and `contextAfter` lines around the edit point are matched to verify the location, similar to unified diff context lines.

3. **Explicit before/after**: `oldLines` (what to remove) and `newLines` (what to insert) are both specified, forcing precision.

4. **Progressive fuzzy matching**: A 3-level cascade — exact match (level 0), strip trailing whitespace (level 1), strip all whitespace (level 100). The fuzz level is reported so the LLM can see how cleanly the patch applied.

5. **Structured error messages**: Every error includes the actual content found at the location, enabling self-correction.

6. **JSON schema, not freeform text**: Unlike OpenAI's V4A (which is a text-based format because the model outputs raw text), drone-agent uses structured JSON tool calls. The JSON schema approach is better because we can constrain the output format at the API level without needing a Lark grammar or CFG constraint.

## Post-Release Fixes (commit `2f377a0`)

Five issues were resolved shortly after implementation:

1. **High** (patch-applier.ts): Fuzzy anchor-chain narrowing cascade was broken — `narrowByAnchors` was called with an empty candidates array on fuzzy fallback, making multi-anchor disambiguation unreliable. Fix: snapshot `firstAnchorCandidates` before narrowing, so fuzzy fallbacks retry from the original state.

2. **Medium** (app.tsx): TUI `formatDiffResult` checked for `written` field but the tool actually returns `patched` — success message was never shown. Fix: also check for `patched === true`.

3. **Medium** (file.ts): ANSI escape codes were being sent to the LLM as noise in tool result context, and the TUI was receiving colored lines that started with escape codes instead of `+`/`-`/`@@`, breaking line classification. Fix: always render diff as plain text — the TUI does its own coloring in `formatDiffOutput`.

4. **Low** (patch-applier.ts + file.ts): Removed redundant manual re-application of hunks by adding `patchedLines` field to `PatchResult`.

5. **Low** (file.test.ts): Added 3 round-trip integration tests — full tool execution output verification and TUI `formatDiffResult` coverage.

## Consequences

- **Positive**: Patches are robust to file evolution — adding or removing lines above the edit point doesn't break the patch
- **Positive**: The LLM gets structured error feedback with actual file content for self-correction
- **Positive**: Fuzz tracking gives the LLM visibility into match quality
- **Positive**: The mini-tutorial-style tool description helps the model learn the format
- **Negative**: The format is more verbose than line-number-based hunks (requires context lines)
- **Negative**: The model must be prompted to use the new format (not co-trained on it like OpenAI's models)

## Implementation

- `drone-agent/src/shared/patch-applier.ts` — Core matching engine with `applyPatch()`, `PatchHunk`, `PatchResult`, `PatchError` types
- `drone-agent/src/shared/diff-renderer.ts` — Added `FuzzLevel`, `DiffHunkV2`, `renderDiffV2()`
- `drone-agent/src/plugins/file.ts` — Rewrote `file__apply_diff` tool with new schema and mini-tutorial description
- `drone-agent/test/file.test.ts` — 28 tests covering all scenarios (plus 3 round-trip integration tests)

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — File plugin
- [028-tool-name-separator](028-tool-name-separator.md) — Tool name format (double underscore)
- [038-file-apply-diff-unified-diff](038-file-apply-diff-unified-diff.md) — Superseding ADR (unified diff format)
