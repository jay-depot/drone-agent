---
tags: [decision, lsp, ergonomics, position-resolution]
related: [concepts/lsp-symbolic-resolution.md, decisions/136-lsp-symbolic-resolution.md, modules/drone-core.md, modules/drone-agent-plugins.md]
---

# 138: LSP Symbolic Resolution Round 2 — Dense Context Blocks, Exact-Match Filter, Reference Cache Hardening

**Status**: Implemented (2026-08-17)

## Context

A review of the LSP symbolic resolution implementation (decision 136) found four defects:

1. **`code_action` cross-file bug** — the `referenceId` branch used the *input* `filePath` for the runtime/document/diagnostics, but the range came from `ref.filePath`. For workspace ambiguity (matches spanning files), re-invoking with a referenceId targeted the wrong file. `rename` already did this correctly.

2. **Window mismatch between suggestion and filter** — `suggestSurroundingText` expanded its search window 5→30 lines, but the filter only searched a fixed 2/3 (or 3/2) window. So a suggested line far from the match was never found when passed back — the disambiguation silently failed.

3. **`get_diagnostics` regression** — it still resolved `text`/`symbol` and threw on ambiguity, but `surroundingText` had been removed from its schema. A coarse filter tool hard-failed on ambiguity with no way to disambiguate.

4. **Unbounded reference cache** — `storeReferences` appended to a `Map` forever with no eviction or TTL, yet the error message claimed "It may have expired." A slow memory leak in long sessions.

## Decision

### 1. `suggestedSurroundingText` → dense context block `suggestedContext`

The suggestion no longer returns a single line. `suggestContext` (renamed from `suggestSurroundingText`) returns a **dense, contiguous context block** — the slice `[line-1-w, line+w]` at the window `w` that made a line unique, joined by newlines. The field is renamed `suggestedContext` to reflect it is a block, not a single line.

### 2. Filter window sized to the handed-back block + exact-match

The filter (`matchesSurroundingBlock` in `server.ts`) now sizes its search window to the **line count of the handed-back block**, capped at `HARD_CONTEXT_LINES` (30). This guarantees a suggested block is always found when passed back.

Matching is **exact, modulo leading/trailing whitespace (trim only)** — not loose substring. The block's trimmed lines must appear as a contiguous subsequence of the window's trimmed lines. This resolves the "target name appears twice" case: the suggestion's uniqueness check already prevents returning an ambiguous block, and the filter requires the block to appear in exactly one match. A commented variant (`// const value = 1;`) no longer matches `const value = 1;`.

Applies to both `resolveTextPosition` and `resolveSymbolPosition` (document + workspace branches).

### 3. `get_diagnostics` is file/severity-only

Removed `text`/`symbol` params and the `parsePositionInput` call entirely. The tool now filters only by `filePath` and `severity` — the intended "whole-file granularity" design.

### 4. Reference cache cap + TTL + staleness detection

- **Cap**: 100 entries, FIFO eviction (Map preserves insertion order; oldest key deleted when over cap).
- **TTL**: 10 minutes; expired entries are deleted on access.
- **Staleness**: each `ReferenceLocation` stores a `fingerprint` (trimmed line text at the reference's line, computed at store time via `readLineFingerprint`). On `resolveReference`, the file line is re-read; if the file is gone or the line changed, the entry is invalidated and a structured `{ stale: true, referenceId, hint }` response is returned (mirroring the `ambiguous: true` handshake) telling the LLM to re-resolve for fresh IDs.

`resolveReference` became async and returns `{ location, stale } | undefined`. `storeReferences` stays sync (the caller computes the fingerprint via `readLineFingerprint`).

### 5. `code_action` referenceId targets `ref.filePath`

The `code_action` referenceId branch now resolves the runtime/document/diagnostics from `ref.filePath` (via a `targetFilePath` variable), not the input `filePath` — mirroring `rename`.

## Consequences

### Positive

- The suggestion and filter now agree on window semantics — a suggested block is always found when passed back, so the disambiguation works end-to-end.
- Exact-match (trim-only) is consistent with how suggestions are generated, eliminating false disambiguation from commented/partial-line variants.
- The reference cache is bounded (cap + TTL) and detects staleness from file changes, with an honest structured handshake instead of a misleading "may have expired" error.
- `get_diagnostics` no longer hard-fails on ambiguity.

### Negative

- The exact-match semantic is a behavioral contract change: callers must hand back full lines (or dense blocks), not substrings. Existing tests that passed partial-line `surroundingText` had to be updated to full lines.
- `resolveReference` becoming async rippled to `rename`/`code_action` and test mocks.

### Technical notes

- `HARD_CONTEXT_LINES` / `SOFT_CONTEXT_LINES` are now exported from `drone-core/src/position-types.ts` so the suggestion and filter share one source of truth.
- `matchesSurroundingBlock(lines, line, surroundingText)` is a module-level helper in `server.ts`.
- `ReferenceLocation` (with `fingerprint`) and `ReferenceResolution = { location, stale }` types added to `server.ts`.
- `buildStaleResponse(referenceId)` returns `{ stale: true, referenceId, hint }` for both `rename` and `code_action`.

## Files Modified

| File | Changes |
|------|---------|
| `drone-core/src/position-types.ts` | Rename `suggestedSurroundingText`→`suggestedContext`; `suggestContext` returns dense block; export `HARD_CONTEXT_LINES`/`SOFT_CONTEXT_LINES` |
| `drone-core/src/index.ts` | Re-export the two context-line constants |
| `drone-agent/src/plugins/lsp/server.ts` | `matchesSurroundingBlock` exact-match filter (window sized to block); reference cache cap 100 + TTL 10min + staleness (`readLineFingerprint`, async `resolveReference`); `ReferenceLocation`/`ReferenceResolution` types |
| `drone-agent/src/plugins/lsp/tools/editing.ts` | `code_action` referenceId targets `ref.filePath`; stale handshake in `rename`+`code_action`; `buildAmbiguousResponse` computes fingerprints |
| `drone-agent/src/plugins/lsp/tools/diagnostics.ts` | File/severity-only (removed `text`/`symbol` + `parsePositionInput`) |
| `drone-agent/test/lsp-ergonomics.test.ts` | 41 tests (was 34): window-growth, exact-match, cross-file referenceId, stale, cap, TTL, diagnostics schema |

## Related

- [[concepts/lsp-symbolic-resolution]] — The concept page for LSP symbolic resolution
- [[decisions/136-lsp-symbolic-resolution]] — The original implementation this round fixes
- [[modules/drone-core]] — Position types live in drone-core
- [[modules/drone-agent-plugins]] — LSP plugin
