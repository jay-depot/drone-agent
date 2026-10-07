---
tags: [decision, lsp, ergonomics, position-resolution, concurrency]
related: [concepts/lsp-symbolic-resolution.md, decisions/136-lsp-symbolic-resolution.md, decisions/138-lsp-symbolic-resolution-round-2.md, modules/drone-agent-plugins.md]
---

# 139: LSP Symbolic Resolution Round 3 — referenceId Precedence, Cache Concurrency Guard, Stale-Handshake Tests

**Status**: Implemented (2026-08-17)

## Context

A review of the round-2 LSP symbolic resolution work (decision 138) found four follow-up issues:

1. **`code_action` referenceId/text precedence bug + double-parse** — the ambiguity pre-pass ran `parsePositionInput` on `text`/`symbol` *before* the `referenceId` branch was reached. If both `referenceId` and `text` were supplied, an ambiguous `text` returned an ambiguous-response and **ignored the `referenceId`** the caller supplied to disambiguate. Also, unambiguous text was parsed twice (pre-pass + the text/symbol branch).

2. **Missing stale-handshake tool test** — `buildStaleResponse` (the `{ stale: true, referenceId, hint }` handshake) was completely untested at the tool level. The stale path was only covered at the `resolveReference` cache level, not in `rename`/`code_action`.

3. **Reference cache concurrency** — `storeReferences` mutated `referenceCache` + `referenceCounter` (a plain `let`), and `resolveReference` did read-delete-write on the same `Map`. The conversation service runs tool calls in a turn in parallel via `Promise.all`, so concurrent calls could interleave and produce duplicate reference IDs.

4. **Window coupling between suggestion and filter** — `suggestContext` returns `[line-1-w, line+w]` (`2w+1` lines); `matchesSurroundingBlock` sizes its window to `blockLines.length` (capped at `HARD_CONTEXT_LINES`). The concern was that correctness depends on the two staying in lockstep.

## Decision

### 1. `code_action` referenceId takes precedence; single-parse

The ambiguity pre-pass is now guarded with `!input.referenceId && (text || symbol)`. When a `referenceId` is present it short-circuits before any text parse, so an ambiguous `text` can no longer override the caller's explicit choice, and unambiguous text is parsed only once (in the text/symbol branch).

### 2. Stale-handshake tool tests

Added tests for both `rename` and `code_action` asserting they return `{ stale: true, referenceId, hint }` when `resolveReference` reports a stale reference. The `get_diagnostics` "ignores text" test was intentionally **not** added — the tool no longer accepts `text`, so no behavioral test is possible.

### 3. Reference cache concurrency guard

Added an in-process promise-chain mutex (`withCacheLock`) that serializes `storeReferences` and `resolveReference` against the parallel tool-call execution in the conversation service:

```typescript
let cacheLock: Promise<void> = Promise.resolve();
function withCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = cacheLock.then(fn);
  cacheLock = run.then(
    () => {},
    () => {}
  );
  return run;
}
```

`storeReferences` became async (`(locations) => Promise<string[]>`), and both it and `resolveReference` wrap their shared-state mutations in `withCacheLock`. This prevents counter collisions and interleaved read-delete-write on the shared `Map`.

### 4. Fixed-window disambiguation — REJECTED, original kept

The proposed fix (a fixed `HARD_CONTEXT_LINES` window in `matchesSurroundingBlock`) was **evaluated and rejected**. Applying it broke 5 existing disambiguation tests. Root cause: a fixed 30-line window makes a short block (e.g. `class User {`) appear in the window of *every* nearby match (in a small file, both windows span the whole file), so it can no longer disambiguate. The whole point of the small window is that a short block only appears near its own match.

The **original** `window = Math.min(blockLines.length, HARD_CONTEXT_LINES)` is already intrinsically stable:
- The filter sizes its window to the actual handed-back block length `L`, so the block always fits (window of `L` before/after = `2L+1` total ≥ `L`).
- Short blocks → small windows → disambiguation works (a short block only appears near its own match).
- The only coupling is through the shared `HARD_CONTEXT_LINES` cap, which is already the single source of truth.

The plan's premise ("correctness depends on lockstep") was **false**. The original is already optimal and intrinsically stable. The new hard-limit round-trip test (a ~30-line block handed back resolves correctly) was kept — it passes with the original code and adds value.

## Consequences

### Positive

- `code_action` no longer ignores an explicit `referenceId` when `text` is also present; unambiguous text is parsed once.
- The stale handshake is now covered by tool-level tests for both `rename` and `code_action`.
- The reference cache is safe under concurrent tool calls (no duplicate IDs, no interleaved mutations).
- The disambiguation window remains intrinsically stable — no regression from the rejected fixed-window change.

### Negative

- `storeReferences` becoming async rippled to `editing.ts` (`buildAmbiguousResponse` now `await`s it) and all test mocks (`storeReferences: async () => []`).

### Technical notes

- `withCacheLock` is a module-local promise-chain mutex in `server.ts` — no external dependency.
- `storeReferences` signature changed from `(locations) => string[]` to `(locations) => Promise<string[]>` in the `ServerManager` type.
- The rejected fixed-window change was reverted; `matchesSurroundingBlock` keeps `window = Math.min(blockLines.length, HARD_CONTEXT_LINES)`.

## Files Modified

| File | Changes |
|------|---------|
| `drone-agent/src/plugins/lsp/tools/editing.ts` | Guard the ambiguity pre-pass with `!input.referenceId`; `await storeReferences` |
| `drone-agent/src/plugins/lsp/server.ts` | `withCacheLock` mutex; `storeReferences` async; `resolveReference` wrapped in lock; `ServerManager` type updated |
| `drone-agent/test/lsp-ergonomics.test.ts` | 46 tests (was 41): referenceId+text precedence, rename/code_action stale responses, concurrent storeReferences ID uniqueness, hard-limit block round-trip |

## Related

- lsp-symbolic-resolution — The concept page for LSP symbolic resolution
- [136-lsp-symbolic-resolution](136-lsp-symbolic-resolution.md) — The original implementation
- [138-lsp-symbolic-resolution-round-2](138-lsp-symbolic-resolution-round-2.md) — Round-2 fixes this round builds on
- [drone-agent-plugins](../../drone-agent/src/plugins/) — LSP plugin
