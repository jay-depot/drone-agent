---
tags: [decision, file-plugin, diff-format]
related: [drone-agent-plugins.md, 033-file-apply-diff-v2.md, 073-apply-diff-matching-cascade-redesign.md]
---

# 038: Flat Unified Diff Format for `file__apply_diff`

**Status**: Input format preserved; matching engine superseded by [073-apply-diff-matching-cascade-redesign](073-apply-diff-matching-cascade-redesign.md) (2026-07-19)

**Note**: The unified diff *input format* introduced by this ADR is still in use and is a success — LLMs produce valid unified diff strings reliably. However, the *matching engine* (contiguous-block matching, dropped interleaved context, whole-line heading match) was replaced by the 4-step cascade in [073-apply-diff-matching-cascade-redesign](073-apply-diff-matching-cascade-redesign.md) (aggressive fuzz, partial success, cheat-sheet error reporting). The parser, `patch-applier.ts`, and `file.ts` were rewritten under ADR 073.

**Supersedes**: [033-file-apply-diff-v2](033-file-apply-diff-v2.md)

## Context

ADR 033 introduced a **content-anchor-based patch format** for `file__apply_diff` — replacing fragile line numbers with structured JSON hunks using `anchors`, `contextBefore`, `contextAfter`, `oldLines`, and `newLines` (each an array of strings). The argument was that JSON schema is better than freeform text because we can constrain the output format at the API level.

**In practice, this didn't work well.** The LLM struggled to reliably produce the nested array-of-objects-of-arrays structure. Malformed JSON, incorrect field nesting, and mismatched arrays were common. The tool description's mini-tutorial couldn't compensate for the inherent complexity of the format.

## Decision

Replace the nested JSON hunk format with a **flat unified diff string** (`patch` parameter). The tool now accepts:

```json
{
  "path": "/absolute/path/to/file.ts",
  "patch": "@@ -5,7 +5,7 @@ function_name():\n     context\n     context\n-    old line\n+    new line\n     context"
}
```

This is the same `git diff` format that LLMs are familiar with from training data and everyday use.

### Key Design Choices

1. **Standard unified diff format, not a custom DSL**: LLMs already understand `@@` hunk headers, ` ` context lines, `-` deletions, and `+` additions. No new format to learn.

2. **Line numbers are soft hints, not requirements**: The `-start` line number from `@@ -start,count +start,count @@` is extracted as a `lineHint` — it prioritizes search near that line but falls through to full-file context matching if nothing matches. This preserves the robustness of content-anchor matching.

3. **Section headings are soft anchors**: The trailing text after `@@ ... @@` (e.g., `function_name():`) is used as a search hint, not a requirement.

4. **Progressive whitespace matching preserved**: The same 3-level cascade (exact → strip trailing whitespace → strip all whitespace) that made ADR 033's format robust remains in place. The LLM can supply slightly-off whitespace and the patch still applies.

5. **Error messages speak in unified-diff terms**: Instead of internal terms like `anchors`, `contextBefore`, `contextAfter`, errors now say things like "the `-` lines didn't match what's in the file" and always end with "Re-read the file with `file__read` to confirm."

6. **Clean break**: The old `hunks` and `color` parameters are fully removed. No backward compatibility.

### Why This Revisits ADR 033's Core Tradeoff

ADR 033 explicitly chose JSON schema over freeform text, arguing "we can constrain the output format at the API level without needing a Lark grammar or CFG constraint." The pragmatic lesson: **LLMs produce valid unified diff strings more reliably than valid nested JSON structures**, even within a JSON tool call. The `patch` parameter is still a string inside a JSON object, so it's not truly "freeform" — but the string itself follows a well-known format that the model knows from training.

## Implementation

### New file: `drone-agent/src/shared/unified-diff-parser.ts`

A pure regex-based parser that converts unified diff strings into the existing `PatchHunk[]` format used by `applyPatch()`:

- Splits input by `@@` headers using regex: `/^@@[ ]+-(\d+)(?:,(\d+))?[ ]+\+(\d+)(?:,(\d+))?[ ]+@@(.*)$/m`
- Extracts `lineHint` (old-file start line) and `sectionHeading` (trailing text)
- Classifies body lines by prefix: ` ` → context, `-` → oldLines, `+` → newLines, `\` → no-newline marker (dropped)
- Assigns context lines before first change to `contextBefore`, after last change to `contextAfter`

Edge cases handled: single/multi-hunk, pure insertion (`@@ -1,0 +1,3 @@`), pure deletion (`@@ -3,3 +0,0 @@`), section headings, no-newline markers, git file headers (`---`/`+++`), empty input.

### Modified: `drone-agent/src/shared/patch-applier.ts`

Added optional `lineHint` and `sectionHeading` fields to `PatchHunk`. Modified `applyPatch()` to use them as soft search hints:

- **Anchored search**: After finding anchor candidates, sort by proximity to `lineHint`
- **Context-only search**: Try a focused window around `lineHint` (±15 lines) before full-file search
- **Section heading**: When no anchors are present, try `sectionHeading` as a soft anchor before falling to context-only search

### Modified: `drone-agent/src/plugins/file.ts`

- New `inputSchema: { path, patch }` — replaces `{ path, hunks, color }`
- New `execute` handler: validates → reads file → `parseUnifiedDiff()` → `applyPatch()` → renders → writes
- New `formatPatchError()` function producing concise, LLM-friendly error messages in unified-diff language
- Simplified tool description showing a unified diff example instead of the old mini-tutorial
- Removed `isRecord` import (was only used for hunks parsing)
- Plugin version bumped to `0.3.0`

## Consequences

- **Positive**: LLMs produce valid unified diff strings more reliably than valid nested JSON
- **Positive**: The patch format is self-explanatory — no mini-tutorial needed in the tool description
- **Positive**: Reuses the existing `applyPatch()` content-anchor matching engine, fuzzy matching, and error infrastructure
- **Positive**: Error messages are more actionable — "the `-` lines didn't match" with "re-read the file" nudge
- **Positive**: Line hints and section headings provide free search prioritization without adding complexity
- **Negative**: The parser is more complex than the old hunks-is-just-PatchHunk approach — but it's still pure regex, no dependencies
- **Negative**: Tool description is slightly longer, but the format is more familiar to the model

## Implementation Files

- `drone-agent/src/shared/unified-diff-parser.ts` — New unified diff parser
- `drone-agent/src/shared/patch-applier.ts` — Extended with lineHint/sectionHeading + hint-based search
- `drone-agent/src/plugins/file.ts` — Rewritten tool registration
- `drone-agent/test/unified-diff-parser.test.ts` — 15 parser tests
- `drone-agent/test/file.test.ts` — Updated round-trip tests, 5 new tests

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — File plugin
- [033-file-apply-diff-v2](033-file-apply-diff-v2.md) — Superseded ADR for content-anchor format