---
tags: [decision, lsp, ergonomics, position-resolution]
related:
  [
    concepts/lsp-symbolic-resolution.md,
    decisions/136-lsp-symbolic-resolution.md,
    decisions/138-lsp-symbolic-resolution-round-2.md,
    decisions/139-lsp-symbolic-resolution-round-3.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
  ]
---

# 140: LSP Symbolic Resolution Round 4 — code_action query.filePath + ref.range, minimal `suggestedContext` block, concurrency tradeoff documented

**Status**: Implemented (2026-08-17)

## Context

A review of the round-3 LSP symbolic resolution work (decision 139) found six follow-up items. Four were addressed in this round; the fifth (a pre-existing flaky test-isolation fix) was deferred; the sixth (a symmetry regression test) was revised during execution after the user clarified the intended block shape.

1. **`code_action` query.filePath bug** — the end of `createCodeActionTool.execute` returned `query: { filePath, range }` using the _input_ `filePath`, not `targetFilePath`. When a `referenceId` resolved cross-file, the tool operated on `ref.filePath` but reported the input filePath. `rename` already did this correctly (`resolved.document.uri`).

2. **`suggestedContext` returned the entire window** — `suggestContext` returned the full `[line-1-w, line+w]` window block (up to 61 lines at the hard limit), not a minimal disambiguating block. The LLM had to reproduce a large exact block to disambiguate, which is brittle.

3. **Concurrency tradeoff undocumented** — `withCacheLock` holds the lock across the disk read in `resolveReference` (`readLineFingerprint`), serializing reference resolution behind a `stat`+`readFile`. This is an accepted tradeoff (concurrency in these tools is rare), but it wasn't documented.

4. **`code_action` referenceId branch reconstructed the range** — it rebuilt `end: { line: ref.range.start.line, character: ref.range.start.character + 1 }` instead of using the stored `ref.range` directly.

5. **Symmetry regression test** — the plan proposed asserting `suggestedContext` is symmetric (odd n+1+n). During execution this was found to be based on crossed signals in planning: the minimal block (item 2) is asymmetric by construction. The user confirmed "option 1" (minimal asymmetric block), so the symmetry assertion was replaced with minimality/anchoring tests.

6. **Coordinator spawn test flakiness** — a pre-existing cross-file test-isolation issue under `singleFork: true` (mcp-client.test.ts leaks a global `fetch` mock). **Deferred** to a follow-up step.

## Decision

### 1. `code_action` query.filePath reports `targetFilePath`

The returned `query.filePath` now uses `targetFilePath` (which is `ref.filePath` when a `referenceId` is supplied) instead of the input `filePath`. This makes the reported query match the file the tool actually operated on.

### 2. `suggestedContext` is a minimal block via nearest-unique-line anchoring

`suggestContext` now anchors on the **unique line nearest the match** (min `|line - match.line|`) and returns the contiguous block from that line to the match line (inclusive). This is the minimal unique block (`min(d_above, d_below) + 1` lines). It is guaranteed unique because any block containing a unique line cannot appear in another match's window.

This sidesteps the top-first / bottom-first / alternate trim-ordering question entirely — the nearest-unique-line anchoring is provably optimal and ordering-independent. The trim rubric ("trim one more line violates uniqueness, or removes the target line") is the documented rationale.

### 3. Concurrency tradeoff documented

The `withCacheLock` comment in `server.ts` now notes that the lock is held across the disk read in `resolveReference` (`readLineFingerprint`), serializing reference resolution behind a `stat`+`readFile`, and that this is an accepted tradeoff because concurrency in these tools is rare and correctness of the shared cache matters more than the small serialization cost. No behavioral change.

### 4. `code_action` uses `ref.range` directly

The referenceId branch now sets `range = ref.range` instead of reconstructing the end position. The stored range already encodes the correct 1-char span.

### 5. Symmetry test revised to minimality/anchoring tests

The plan's symmetry assertion (odd n+1+n on `suggestedContext`) was based on crossed signals. Per the user's "option 1" decision, the minimal block is asymmetric by construction. Replaced with:

- **"suggests a minimal block for each ambiguous match"** — asserts the block collapses to the match line when the match line is unique.
- **"anchors on the nearest unique line when the match line is not unique"** — asserts match1 anchors on a marker 2 lines above and match2 on a marker 1 line below.

The two `rename`/`code_action` ambiguity tests that asserted `toContain('FIRST')` were updated to assert the exact minimal block.

### 6. Coordinator spawn test isolation — DEFERRED

The pre-existing flaky test-isolation fix (coordinator spawn test holds its own mock reference; mcp-client.test.ts uses `vi.stubGlobal`/`unstubAllGlobals`) remains for a follow-up step.

## Consequences

### Positive

- `code_action` reports the correct file in its query when a `referenceId` resolves cross-file.
- `suggestedContext` is now a compact, guaranteed-unique block the LLM can reliably hand back — far more robust to LLM reformatting/truncation than the old 61-line window.
- The concurrency tradeoff is documented for future maintainers.
- `code_action` no longer re-derives a range that's already stored.

### Negative

- The `suggestedContext` block shape changed from the full window to a minimal block — any consumer expecting the old dense window must adapt (the crib-sheet consumers in `rename`/`code_action` were updated).
- The deferred test-isolation fix (item 6) still needs to be done to make the fast suite reliably green.

### Technical notes

- `suggestContext` now tracks unique lines by index (not trimmed text) so it can compute the nearest unique line to the match.
- The minimal block is asymmetric by design — it is NOT n+1+n symmetric. The window (maximal context) remains symmetric; the block (minimal context) is anchored on the nearest unique line.

## Files Modified

| File                                           | Changes                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `drone-agent/src/plugins/lsp/tools/editing.ts` | `query.filePath` → `targetFilePath`; referenceId branch uses `range = ref.range`                                           |
| `drone-core/src/position-types.ts`             | `suggestContext` anchors on nearest unique line, returns minimal block; jsdoc updated                                      |
| `drone-agent/src/plugins/lsp/server.ts`        | `withCacheLock` comment documents the disk-read tradeoff                                                                   |
| `drone-agent/test/lsp-ergonomics.test.ts`      | 47 tests (was 46): minimal-block test, nearest-unique-line anchoring test; updated rename/code_action ambiguity assertions |

## Related

- lsp-symbolic-resolution — The concept page for LSP symbolic resolution
- [136-lsp-symbolic-resolution](136-lsp-symbolic-resolution.md) — The original implementation
- [138-lsp-symbolic-resolution-round-2](138-lsp-symbolic-resolution-round-2.md) — Round-2 fixes (dense blocks, exact-match, cache hardening)
- [139-lsp-symbolic-resolution-round-3](139-lsp-symbolic-resolution-round-3.md) — Round-3 fixes (referenceId precedence, cache concurrency guard)
- [drone-core](../../drone-core/) — `position-types.ts` `suggestContext`
- [drone-agent-plugins](../../drone-agent/src/plugins/) — LSP plugin
