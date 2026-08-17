---
key: plan-lsp-symbolic-resolution-fixes-round-3
tags: []
created: 2026-08-17T19:13:58.881Z
updated: 2026-08-17T19:45:42.768Z
---

# Plan: Round-3 fixes for LSP symbolic-resolution improvements

## Summary

Four follow-up fixes to the LSP symbolic-resolution work (surroundingText disambiguation, auto-expansion, reference IDs) found during review. Fixes a real precedence bug in code_action, fills a missing stale-handshake test, hardens the reference cache against concurrent tool calls, and replaces the brittle window-math coupling between suggestContext and matchesSurroundingBlock with an intrinsically stable approach.

## Issues & agreed fixes

1. **code_action referenceId/text precedence + double-parse** — the ambiguity pre-pass (editing.ts ~170-181) runs parsePositionInput on text/symbol BEFORE the referenceId branch is reached. If both referenceId and text are supplied, an ambiguous text returns an ambiguous-response and IGNORES the referenceId the caller supplied to disambiguate. Also, unambiguous text is parsed twice (pre-pass + the text/symbol branch). Fix: skip the pre-pass when referenceId is present; short-circuit referenceId first.
2. **Missing stale-handshake tool test (plan Step 6)** — buildStaleResponse is completely untested. Add a test that rename/code_action return `{ stale: true, referenceId, hint }` when resolveReference returns stale. The Step 5 "get_diagnostics ignores text" test is SKIPPED (tool no longer accepts the param, so no behavioral test is possible).
3. **Reference cache concurrency** — storeReferences mutates referenceCache + referenceCounter (plain let) and resolveReference does read-delete-write on the same Map. Conversation service runs tool calls in parallel via Promise.all. Add an in-process per-cache mutex to serialize storeReferences/resolveReference.
4. **Intrinsically stable window coupling** — suggestContext returns `[line-1-w, line+w]` (2w+1 lines); matchesSurroundingBlock sizes its window to blockLines.length (capped at HARD_CONTEXT_LINES). Correctness depends on the two staying in lockstep. Fix: matchesSurroundingBlock always searches a fixed HARD_CONTEXT_LINES window before/after the match line — the same constant that bounds the suggestion. Since suggestContext never exceeds HARD_CONTEXT_LINES before/after, a filter window of HARD_CONTEXT_LINES before/after is guaranteed to contain any block the suggestion can produce. Coupling is now only through the shared constant (single source of truth). Also makes round-trip robust to shorter blocks.

## Steps

### Step 1 — code_action precedence + single-parse (editing.ts)

File: drone-agent/src/plugins/lsp/tools/editing.ts

- In createCodeActionTool.execute, guard the ambiguity pre-pass so it does NOT run when referenceId is present:
  `if (!input.referenceId && (typeof input.text === 'string' || typeof input.symbol === 'string')) { ... }`
- The referenceId branch already comes first in the if/else chain, so once the pre-pass is guarded, referenceId short-circuits correctly and text is parsed only once (in the text/symbol branch).
- Add a test: code_action with BOTH referenceId and an ambiguous text returns the referenceId-targeted result (not an ambiguous response). Use the existing mock-server pattern (createCodeActionTool with a mock resolveReference returning a non-stale location, and a parsePositionInput that would throw AmbiguousPositionError if called).
- Dependency: none. Agent: coder.

### Step 2 — stale-handshake tool test (lsp-ergonomics.test.ts)

File: drone-agent/test/lsp-ergonomics.test.ts

- Add a test that rename returns the stale response when resolveReference returns `{ stale: true }`: mock server resolveReference returns `{ location, stale: true }`, call createRenameTool.execute with referenceId, assert parsed JSON has `stale: true`, `referenceId`, and a hint.
- Add the same for code_action.
- Do NOT add a get_diagnostics "ignores text" test (skipped per user — tool no longer accepts text).
- Dependency: Step 1 (mock pattern). Agent: coder.

### Step 3 — reference cache concurrency guard (server.ts)

File: drone-agent/src/plugins/lsp/server.ts

- Add an in-process mutex (a simple promise-chain or a small helper) that serializes storeReferences and resolveReference. Since storeReferences is sync and resolveReference is async, wrap the shared-state mutations in the mutex.
- Simplest approach: a `let cacheLock: Promise<void> = Promise.resolve();` and a helper `withCacheLock<T>(fn: () => Promise<T>): Promise<T>` that chains onto cacheLock. storeReferences becomes async (or returns ids after awaiting the lock); resolveReference awaits the lock around its read-delete-write.
- Update ServerManager type: storeReferences becomes `(locations: ReferenceLocation[]) => Promise<string[]>` (async). Sweep all implementers/consumers: server.ts return object, editing.ts buildAmbiguousResponse (await storeReferences), and all test mocks in lsp-ergonomics.test.ts (storeReferences: async () => []).
- Add a test: fire N concurrent storeReferences calls (Promise.all) and assert all returned IDs are unique (no counter collision).
- Dependency: none. Agent: coder.

### Step 4 — intrinsically stable window (server.ts)

File: drone-agent/src/plugins/lsp/server.ts

- In matchesSurroundingBlock, replace `const window = Math.min(blockLines.length, HARD_CONTEXT_LINES);` with a fixed window: `const window = HARD_CONTEXT_LINES;` (search HARD_CONTEXT_LINES before/after the match line). The block is still matched as a contiguous run of trimmed lines within that window.
- Update the jsdoc to explain the invariant: the filter window is fixed at HARD_CONTEXT_LINES (the same constant that bounds suggestContext), so any block the suggestion can produce is guaranteed to be found. Coupling is only through the shared constant.
- Add a test: a block near the hard limit (e.g. a 25-30 line block) handed back resolves correctly (round-trip at the cap). Also keep the existing window-growth test passing.
- Dependency: none. Agent: coder.

### Step 5 — validation

- LSP zero errors across all touched files.
- pnpm -r run build (drone-core unchanged, but rebuild to be safe).
- pnpm -r run lint zero errors.
- Fast test suite passes (pnpm test), especially lsp-ergonomics.test.ts.

## Files touched

- drone-agent/src/plugins/lsp/tools/editing.ts
- drone-agent/src/plugins/lsp/server.ts
- drone-agent/test/lsp-ergonomics.test.ts

## Notes

- storeReferences becoming async ripples to editing.ts and test mocks — sweep all implementers/consumers (LSP find-references + grep for storeReferences).
- The referenceId precedence fix and the stale-handshake test are the two correctness items; the concurrency guard and window fix are hardening.
- Per project principle: plugin tools doing read-modify-write on shared state must defend against concurrent tool calls (Promise.all in conversation service).

## Validation criteria

- LSP diagnostics clean on all touched files.
- pnpm -r run build and pnpm -r run lint pass with zero errors.
- pnpm test passes, especially lsp-ergonomics.test.ts (all existing + new tests).
- New tests: code_action referenceId+text precedence; rename stale response; code_action stale response; concurrent storeReferences ID uniqueness; hard-limit block round-trip.
- No dead code or unused variables; new code covered by unit tests.

## COMPLETED (2026-08-17) — Steps 1-3 implemented and verified; Step 4 evaluated and REJECTED

### Step 1 (code_action precedence + single-parse) — DONE

- editing.ts: guarded the ambiguity pre-pass with `!input.referenceId && (text || symbol)`. referenceId now short-circuits before any text parse; unambiguous text is parsed only once.
- Test added: "code_action with both referenceId and ambiguous text prefers the referenceId" — mock parsePositionInput throws AmbiguousPositionError if called; asserts no ambiguous response and parseCalled === false.

### Step 2 (stale-handshake tool tests) — DONE

- Added "rename returns a stale response when the referenceId is stale" and "code_action returns a stale response when the referenceId is stale" — mock resolveReference returns { stale: true }; assert parsed JSON has stale:true, referenceId, and hint containing 'Re-resolve'.
- get_diagnostics "ignores text" test intentionally NOT added (tool no longer accepts text).

### Step 3 (reference cache concurrency guard) — DONE

- server.ts: added `withCacheLock` promise-chain mutex serializing storeReferences and resolveReference. storeReferences is now async (returns Promise<string[]>).
- ServerManager type updated; editing.ts buildAmbiguousResponse awaits storeReferences; all test mocks updated to `storeReferences: async () => []`; real-server test calls now `await server.storeReferences(...)`.
- Test added: "assigns unique IDs under concurrent storeReferences calls" — 50 parallel calls, all 50 IDs unique.

### Step 4 (intrinsically stable window) — REJECTED, original code KEPT

The plan's proposed fixed-window fix (`window = HARD_CONTEXT_LINES`) is FUNDAMENTALLY BROKEN. Applying it caused 5 existing tests to fail:

- "disambiguates multiple text matches with surroundingText" (1-line block `class User {` disambiguating line 2 vs line 6 of a 6-line file)
- "disambiguates via surroundingText parameter" / "from input field" (1-line blocks)
- "grows the filter window to match a multi-line handed-back block"
- "uses exact match (trim-only), not substring, for disambiguation"

Root cause: a fixed 30-line window makes a short block appear in the window of EVERY nearby match (in a small file, both windows span the whole file), so it can no longer disambiguate. The whole point of the small window is that a short block only appears near its own match.

The ORIGINAL `window = Math.min(blockLines.length, HARD_CONTEXT_LINES)` is ALREADY intrinsically stable:

- The filter sizes its window to the actual handed-back block length L, so the block always fits (window of L before/after = 2L+1 total >= L).
- Short blocks → small windows → disambiguation works (a short block only appears near its own match).
- The only coupling is through the shared HARD_CONTEXT_LINES cap, which is already the single source of truth.

The plan's premise ("correctness depends on lockstep") is FALSE. The original is already optimal and intrinsically stable. KEPT original code.

KEPT the new hard-limit round-trip test ("resolves a block near the hard context limit") — it passes with the original code and adds value (verifies round-trip at the cap).

### Step 5 (validation) — DONE

- LSP diagnostics clean on all touched files.
- pnpm -r run build: pass. pnpm -r run lint: pass.
- pnpm test: lsp-ergonomics.test.ts 46/46 pass (was 41 before this work; +5 new tests).
- drone-agent tsc --noEmit: clean.

### Final state

- 5 new tests added (precedence, rename stale, code_action stale, concurrent IDs, hard-limit block). All pass.
- Step 4 code change reverted; original matchesSurroundingBlock kept.
- All validation criteria met.
