---
key: plan-lsp-symbolic-resolution-fixes-round-2
tags: []
created: 2026-08-17T18:16:47.706Z
updated: 2026-08-17T18:16:47.706Z
---

---

key: plan-lsp-symbolic-resolution-fixes-round-2
tags:

- plan
- lsp
- symbolic-resolution
- surroundingText
- reference-id
- drone-core
  created: 2026-08-17T17:45:00.000Z
  updated: 2026-08-17T17:45:00.000Z

---

# Plan: Fix 4 issues in LSP symbolic-resolution improvements (round 2)

## Summary

The LSP symbolic-resolution improvements (surroundingText disambiguation, auto-expansion snippets, reference IDs) shipped with four defects found during review/testing. This plan fixes all four. The work spans `drone-core` (position-types) and `drone-agent` (LSP plugin server + tools).

## Issues & agreed fixes

1. **`code_action` cross-file bug** — the `referenceId` branch uses the _input_ `filePath` for runtime/document/diagnostics, but the range comes from `ref.filePath`. For workspace ambiguity (matches spanning files), re-invoking with a referenceId targets the wrong file. Fix: when a referenceId is supplied, target using `ref.filePath` (runtime, document, diagnostics filter). `rename` already does this correctly — mirror it.

2. **Window mismatch between suggestion and filter** — `suggestSurroundingText` expands 5→30 lines, but the filter only searches a fixed 2/3 (or 3/2) window, so suggested lines far from the match are never found. Fix (per user direction):
   - The suggestion returns a **dense, contiguous context block** (unique line + neighbors, centered on the match) rather than a single line.
   - The filter sizes its search window to the **line count of the handed-back block**, capped at the 30-line hard limit.
   - The filter matches **exact, modulo whitespace (trim only)** — not loose substring — consistent with how suggestions are generated. This also resolves the "target name appears twice" case: the suggestion's uniqueness check already prevents returning an ambiguous block, and the filter requires the block to appear in exactly one match.
   - Applies to both `resolveTextPosition` and `resolveSymbolPosition`.

3. **`get_diagnostics` regression** — it still resolves `text`/`symbol` and throws on ambiguity, but `surroundingText` was removed from its schema. Fix: remove `text`/`symbol` params and the `parsePositionInput` call entirely — make it file/severity-only (the intended "whole-file granularity" design).

4. **Unbounded `referenceCache` + staleness** — Fix: cap at 100 entries (FIFO), TTL 10 minutes, plus **staleness detection**: store a line-text fingerprint at creation; on resolve, if the line changed or the file is gone, invalidate the entry and return a structured `stale: true` response (mirroring the `ambiguous: true` handshake) telling the LLM to re-resolve. Applies to both `rename` and `code_action`.

## Design decisions

- `AmbiguousMatch.suggestedSurroundingText` becomes a multi-line dense block. Rename field to `suggestedContext` (string | undefined) to reflect it is a block, not a single line.
- `storeReferences` must capture a line fingerprint at store time → becomes async (reads the file) OR the fingerprint is passed in by the caller. Prefer: `storeReferences` stays sync but takes the fingerprint as part of the location payload; the caller (`buildAmbiguousResponse`) computes the fingerprint via a new `readLineFingerprint(filePath, line)` helper. This keeps `storeReferences` sync and testable.
- Stale check: on `resolveReference`, re-read the file line; if file missing or line text (trimmed) differs from stored fingerprint, delete the entry and return a `{ stale: true }` signal. `resolveReference` becomes async.
- Cache: `Map` + FIFO cap (100) + TTL (10 min). Store `{ location, fingerprint, createdAt }`. Evict expired on access and on insert when over cap.
- `get_diagnostics`: drop `text`/`symbol` from schema + description; remove `parsePositionInput` call; keep `filePath` + `severity` filtering.

## Steps

### Step 1 — drone-core: `AmbiguousMatch.suggestedSurroundingText` → dense block `suggestedContext`

File: `drone-core/src/position-types.ts`

- Rename field `suggestedSurroundingText: string | undefined` → `suggestedContext: string | undefined`. Update jsdoc: "Dense, contiguous context block (unique line + neighbors, centered on the match) that would disambiguate this match from all others, or undefined if no unique block exists within the hard context limit (30 lines before/after)."
- `suggestSurroundingText` → rename to `suggestContext`. Change return to a **block**: when a unique line is found at window `w`, return the contiguous slice `[line-1-w, line+w]` joined by `\n` (the same window that made the line unique), NOT just the single line. Keep the uniqueness check on exact trimmed-line equality.
- `buildAmbiguousMatches`: pass through the new field name.
- Update `drone-core/src/index.ts` re-export if the type name changed (it doesn't — only the field name).
- Tests: `drone-agent/test/lsp-ergonomics.test.ts` — update assertions that reference `suggestedSurroundingText` to `suggestedContext`; assert the block is multi-line and contains the unique line.

### Step 2 — drone-agent server: filter window sized to handed-back context + exact-match

File: `drone-agent/src/plugins/lsp/server.ts`

- `resolveTextPosition`: replace the substring filter with:
  - Compute `blockLineCount = surroundingText.split('\n').length`.
  - `window = Math.min(blockLineCount, HARD_CONTEXT_LINES)` (import/define HARD_CONTEXT_LINES = 30, or reuse from drone-core — export a constant from position-types).
  - For each match, build `contextWindow = lines.slice(max(0, line-1-window), min(lines.length, line+window))`.
  - Filter: match if `contextWindow` contains a contiguous run of lines whose trimmed text equals the handed-back block's trimmed lines (exact, trim-only). Simplest robust approach: normalize both the block and each candidate window slice to trimmed-line arrays and require the block array to appear as a contiguous subsequence of the window array.
  - If exactly one match after filtering → return it. If >1 → use filtered set. If 0 → fall through to ambiguous error (unchanged).
- `resolveSymbolPosition`: apply the same window-sizing + exact-match filter to both the document-symbol branch and the workspace-symbol branch (replace the current `line-3,line+2` substring filters).
- Export `HARD_CONTEXT_LINES` (and `SOFT_CONTEXT_LINES`) from `drone-core/src/position-types.ts` so server.ts and the suggestion share one source of truth.

### Step 3 — drone-agent server: reference cache cap + TTL + staleness

File: `drone-agent/src/plugins/lsp/server.ts`

- Change `referenceCache` value to `{ location, fingerprint, createdAt }`.
- Add `readLineFingerprint(filePath, line): Promise<string | undefined>` — reads the file line (trimmed) or undefined if file missing.
- `storeReferences(locations)` stays sync; each location payload gains a `fingerprint` field (computed by caller). On insert: set `createdAt = Date.now()`; if cache size >= 100, evict oldest (FIFO by insertion order — use a Map which preserves insertion order, delete first key).
- `resolveReference(referenceId)` becomes async: on access, if entry missing → undefined; if `Date.now() - createdAt > 10*60*1000` → delete, return undefined; else re-read fingerprint via `readLineFingerprint`; if file missing or fingerprint differs → delete, return `{ stale: true }`; else return `{ location, stale: false }` (or return the location and signal staleness via a sentinel). Define a return type: `{ location, stale: boolean } | undefined`.
- Update `ServerManager` type signatures for `storeReferences` (location payload gains `fingerprint`) and `resolveReference` (async, new return shape).

### Step 4 — drone-agent editing tools: referenceId targeting + stale handshake

File: `drone-agent/src/plugins/lsp/tools/editing.ts`

- `buildAmbiguousResponse`: before `storeReferences`, compute each match's fingerprint via `server.readLineFingerprint(match.filePath, match.line)` and pass it in the location payload. (Add `readLineFingerprint` to `ServerManager`.)
- `createCodeActionTool` referenceId branch: use `ref.filePath` (not input `filePath`) for `findRuntimeForFile`, `ensureDocumentLoaded`, and the diagnostics filter. Handle stale: if `resolveReference` returns `{ stale: true }`, return a structured `{ stale: true, referenceId, hint: 'Re-resolve the position to get fresh reference IDs.' }` JSON response (mirror `buildAmbiguousResponse` shape). If undefined → keep the existing "not found" error.
- `createRenameTool` referenceId branch: same stale handling (it already uses `ref.filePath` correctly). Add the stale structured response.
- Update tool descriptions to mention the stale handshake.

### Step 5 — drone-agent: `get_diagnostics` file/severity-only

File: `drone-agent/src/plugins/lsp/tools/diagnostics.ts`

- Remove `text` and `symbol` from the input schema and from the description.
- Remove the `parsePositionInput` call and `targetPosition` logic entirely.
- Keep `filePath` + `severity` filtering.
- Update `drone-agent/test/lsp-ergonomics.test.ts`: the `get_diagnostics accepts text/symbol but no surroundingText` test → assert `text`/`symbol` are now absent; add a test that `get_diagnostics` with `text` no longer throws ambiguity (it ignores text).

### Step 6 — tests

File: `drone-agent/test/lsp-ergonomics.test.ts` (+ `drone-core` tests if any)

- Update all `suggestedSurroundingText` references → `suggestedContext`.
- Add tests:
  - Filter window grows to match a multi-line handed-back block (suggest a block 5+ lines away, pass it back, assert it resolves).
  - Exact-match (trim-only): a commented/`const value = 10;` variant in another match's window does NOT disambiguate (substring would have).
  - `code_action` referenceId cross-file: workspace ambiguity across two files, re-invoke with referenceId, assert it targets `ref.filePath` (not input filePath).
  - Stale reference: store a reference, modify the file line, resolve → `stale: true`; entry removed.
  - Cache cap: insert >100, assert oldest evicted (FIFO).
  - TTL: (use fake timers or a small injectable TTL) assert expired entry returns undefined.
  - `get_diagnostics` ignores `text`/`symbol`.
- Update mock `ServerManager` in tests to include `readLineFingerprint` and the new `resolveReference`/`storeReferences` signatures.

### Step 7 — validation

- LSP zero errors across all touched files.
- `pnpm -r run build` (drone-core types changed → rebuild before relying on dependent typecheck).
- `pnpm -r run lint` zero errors.
- Fast test suite passes (`pnpm test`), especially `lsp-ergonomics.test.ts` (34+ tests).

## Files touched

- drone-core/src/position-types.ts
- drone-core/src/index.ts (if re-export changes)
- drone-agent/src/plugins/lsp/server.ts
- drone-agent/src/plugins/lsp/tools/editing.ts
- drone-agent/src/plugins/lsp/tools/diagnostics.ts
- drone-agent/test/lsp-ergonomics.test.ts

## Notes

- drone-core types change → run `pnpm -r run build` before typecheck in drone-agent (per project principle: dependent packages resolve drone-core from dist/).
- `resolveReference` becoming async ripples to `rename`/`code_action` and test mocks — sweep all implementers/consumers (LSP find-references + grep for `resolveReference`/`storeReferences`).
- The stale handshake mirrors the existing `ambiguous: true` response shape for LLM ergonomics.
