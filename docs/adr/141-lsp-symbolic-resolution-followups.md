---
tags: [decision, lsp, ergonomics, position-resolution]
related: [concepts/lsp-symbolic-resolution.md, decisions/136-lsp-symbolic-resolution.md, decisions/138-lsp-symbolic-resolution-round-2.md, decisions/139-lsp-symbolic-resolution-round-3.md, decisions/140-lsp-symbolic-resolution-round-4.md, modules/drone-agent-plugins.md]
---

# 141: LSP Symbolic Resolution Follow-ups — code_action single-parse, 1-based range at agent boundary, one-snippet-per-file (settled), per-key lock re-scoped

**Status**: Implemented (2026-08-17)

## Context

A review of the round-4 LSP symbolic resolution work (decision 140) found four follow-up items. All four were addressed in this round.

1. **`code_action` double-parses unambiguous text** — the ambiguity pre-pass (`editing.ts`) called `parsePositionInput`, discarded the result, and only caught `AmbiguousPositionError`. The text/symbol branch did the exact same thing. For `symbol` resolution this was a wasted `textDocument/documentSymbol` LSP round-trip + file read on every `code_action` call.

2. **Mixed 1-based/0-based range convention** — `locationToAgentShape` returned 1-based `line`/`column` but 0-based `range` in the same object; `code_action`'s `query.range` was 0-based. The LLM saw `line: 5` next to `range.start.line: 4` and had to know the convention flip.

3. **`buildAutoExpansion` dedup regression** — round-2 deduped by file (`seenFiles`); the current code deduped by position (`seenKeys`), so `find_references` with 5 hits in one file read 5 snippets. This is the **second time** the file-level dedup has been flipped, so it is now a **settled decision**.

4. **`withCacheLock` held the lock across a disk read** — `resolveReference` held the session-global promise-chain lock across `readLineFingerprint` (stat+readFile), so one slow disk read blocked every reference operation.

## Decision

### 1. Delete the `code_action` ambiguity pre-pass

The pre-pass (`if (!input.referenceId && (text || symbol)) { parsePositionInput(...) }`) was deleted. The text/symbol branch already handles ambiguity identically (catches `AmbiguousPositionError` and returns reference IDs via `buildAmbiguousResponse`). This removes the redundant LSP round-trip + file read on every `code_action` call with a `symbol`. No behavior change: ambiguous text still returns reference IDs.

### 2. Normalize `range` to 1-based at the agent boundary

`locationToAgentShape` now maps each location's `range` to 1-based (`start.line+1`, `start.character+1`, `end.line+1`, `end.character+1`), matching the already-1-based `line`/`column`. `code_action`'s `query.range` is likewise normalized to 1-based in the returned JSON.

**`ReferenceLocation.range` is intentionally left 0-based internally** — `code_action`'s referenceId branch feeds `ref.range` directly to the LSP server as the request range, so it must stay in raw LSP coordinates. The normalization happens only at the JSON boundary.

### 3. `buildAutoExpansion` dedups by file — SETTLED DECISION

`buildAutoExpansion` dedups by **file** (`seenFiles`), reading one snippet per file. This is a **settled decision** — it has now been flipped twice (round-2 file-level → current position-level → back to file-level), and the file-level behavior is the intended one. The LLM is likely to pull up the whole file after seeing a snippet anyway, so one snippet per file is the right granularity. A regression test asserts that multiple locations in the same file yield exactly one snippet.

### 4. Re-scope the reference-cache lock to exclude the disk read

`resolveReference` now reads the line fingerprint **outside** the lock (the location is immutable once stored), then acquires the lock only for the fast Map mutations (re-check, TTL expiry, stale delete). This lets unrelated references resolve concurrently instead of serializing behind a single session-global lock across a stat+readFile.

A strict per-referenceId lock is **not** used: `storeReferences`' FIFO eviction can delete any key, so all Map mutations must share one lock. The single lock is retained but now held only around the fast mutations.

## Consequences

### Positive

- `code_action` no longer does a redundant LSP round-trip + file read for `symbol` resolution.
- The agent-facing shape is now consistently 1-based (`line`, `column`, and `range`), removing the convention flip the LLM had to infer.
- `buildAutoExpansion` reads one snippet per file, and the behavior is locked in with a regression test and a settled-decision record.
- Unrelated reference resolutions no longer block each other behind a disk read.

### Negative

- The 1-based `range` in the agent-facing shape is a **breaking change** for any consumer that parsed the old 0-based `range` from `locationToAgentShape` or `code_action`'s `query.range`. Internal `ReferenceLocation.range` is unchanged (0-based), so the LSP request path is unaffected.
- The lock is still a single session-global lock (not per-key), so `storeReferences` and the Map-mutation phase of `resolveReference` still serialize — but the slow disk read is no longer inside the lock.

### Technical notes

- The 1-based normalization is applied **only at the JSON boundary** (`locationToAgentShape` and the `code_action` query). `ReferenceLocation.range` stays 0-based because it is fed directly to the LSP server.
- The `withCacheLock` comment now documents why a per-key lock is not used (FIFO eviction can delete any key) and that the lock is held only around fast Map mutations.

## Files Modified

| File | Changes |
|------|---------|
| `drone-agent/src/plugins/lsp/tools/editing.ts` | Deleted the `code_action` ambiguity pre-pass; normalized `query.range` to 1-based |
| `drone-agent/src/plugins/lsp/server.ts` | `locationToAgentShape` normalizes `range` to 1-based; `resolveReference` reads fingerprint outside the lock; `withCacheLock` comment updated |
| `drone-agent/src/plugins/lsp/tools/navigation.ts` | `buildAutoExpansion` dedups by file (`seenFiles`) |
| `drone-agent/test/lsp-ergonomics.test.ts` | 50 tests (was 47): `locationToAgentShape` 1-based range, `code_action` query.range 1-based, `buildAutoExpansion` one-snippet-per-file |

## Related

- lsp-symbolic-resolution — The concept page for LSP symbolic resolution
- [136-lsp-symbolic-resolution](136-lsp-symbolic-resolution.md) — The original implementation
- [138-lsp-symbolic-resolution-round-2](138-lsp-symbolic-resolution-round-2.md) — Round-2 fixes (dense blocks, exact-match, cache hardening)
- [139-lsp-symbolic-resolution-round-3](139-lsp-symbolic-resolution-round-3.md) — Round-3 fixes (referenceId precedence, cache concurrency guard)
- [140-lsp-symbolic-resolution-round-4](140-lsp-symbolic-resolution-round-4.md) — Round-4 fixes (query.filePath, ref.range, minimal suggestedContext block)
- [drone-agent-plugins](../../drone-agent/src/plugins/) — LSP plugin
