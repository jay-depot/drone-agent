---
key: plan-lsp-symbolic-resolution-fixes-round-4
tags:
  []
created: 2026-08-17T20:19:58.710Z
updated: 2026-08-17T20:49:26.967Z
---

# Plan: Round-4 fixes for LSP symbolic-resolution improvements

## Summary
Six follow-up items from review of the LSP symbolic-resolution work (surroundingText disambiguation, auto-expansion, reference IDs). Two real correctness fixes in code_action (query.filePath + ref.range), one design change to suggestedContext (minimal block via nearest-unique-line anchoring), one documentation-only item (concurrency tradeoff), one test-only item (symmetry regression test — code already correct), and one pre-existing flaky test-isolation fix (coordinator spawn, deferred).

## Issues & agreed fixes
1. **code_action query.filePath bug** — end of createCodeActionTool.execute returns `query: { filePath, range }` using the INPUT filePath, not `targetFilePath`. When referenceId resolves cross-file, tool operates on ref.filePath but reports input filePath. rename does it correctly. Fix: use `targetFilePath`.
2. **suggestedContext minimal block** — suggestContext currently returns the ENTIRE window block (up to 61 lines). Per user: after gathering maximal context, trim lines until it can't anymore → minimal contiguous disambiguating block. "Can't" = trimming one more line violates uniqueness, or removes the target line. Applied in both directions. DECISION: implement as "anchor on the nearest unique line" — find the nearest unique line to the match (on either side) and return the block from that line to the match line. This is provably optimal (minimal unique block = min(d_above, d_below) + 1 lines) and sidesteps the top-first/bottom-first/alternate ordering question entirely. Any block containing a unique line can't appear in another match's window, so it's guaranteed unique.
3. **concurrency tradeoff** — withCacheLock holds lock across disk I/O (readLineFingerprint). User accepts: concurrency in these tools is rare. No code change; document the tradeoff.
4. **code_action use ref.range directly** — referenceId branch reconstructs `end: {line: ref.range.start.line, character: ref.range.start.character + 1}` instead of using stored `ref.range`. Fix: use `ref.range` directly.
5. **symmetry** — REVIEW WAS WRONG. suggestContext window start=line-1-window, end=line+window → before=window, after=window, total=2*window+1 (odd, n+1+n). ALREADY symmetric. matchesSurroundingBlock uses identical formula. No code change. Add regression test asserting odd count + n+1+n symmetry.
6. **coordinator spawn test flakiness** — pre-existing, cross-file pollution under singleFork. Passes in isolation (14/14), fails in full suite with `expected 'http://localhost:9999/mcp' to be an instance of URL`. Root cause: vitest `pool: 'forks'` + `singleFork: true` runs all files in one process; mcp-client.test.ts sets `globalThis.fetch = mock.fetch` directly (not vi.stubGlobal) and restores to GUARD_FETCH in afterEach, leaking into coordinator's `vi.mocked(fetch)`. Flakiness varies between runs (spawn/principles/insight all intermittently fail). Fix: coordinator spawn test holds direct reference to its OWN mock; mcp-client.test.ts uses vi.stubGlobal/unstubAllGlobals consistently. DEFERRED: take care of this after the LSP front is stable.

## Steps

### Step 1 — code_action query.filePath + ref.range (editing.ts)
File: drone-agent/src/plugins/lsp/tools/editing.ts
- Line ~397: change `query: { filePath, range }` → `query: { filePath: targetFilePath, range }`.
- Line ~224-227: in the referenceId branch, replace the reconstructed range with `range = ref.range;` (drop the `end: { line: ref.range.start.line, character: ref.range.start.character + 1 }` reconstruction).
- Dependency: none. Agent: coder.

### Step 2 — suggestedContext minimal block via nearest-unique-line anchoring (drone-core/src/position-types.ts)
File: drone-core/src/position-types.ts
- In suggestContext, after finding a window with uniqueLines.length > 0, compute the minimal disambiguating block by anchoring on the nearest unique line:
  - Among the unique lines in the window, find the one closest to the match line (min |line - match.line|).
  - Return the contiguous block from that nearest unique line to the match line (inclusive), joined by '\n'.
  - This is the minimal unique block (min(d_above, d_below) + 1 lines). It is guaranteed unique because it contains a unique line, which cannot appear in any other match's window.
- Update the jsdoc to describe the minimal-block behavior and the nearest-unique-line anchoring rationale.
- Dependency: none. Agent: coder.

### Step 3 — symmetry regression test (lsp-ergonomics.test.ts)
File: drone-agent/test/lsp-ergonomics.test.ts
- Add a test in the suggestedContext describe block: build a file with two matches far apart, trigger ambiguity, assert each match's suggestedContext has an ODD number of lines and is symmetric (n+1+n: equal lines before and after the match line). This locks in the invariant.
- Dependency: Step 2 (block shape). Agent: coder.

### Step 4 — document concurrency tradeoff (server.ts)
File: drone-agent/src/plugins/lsp/server.ts
- Update the withCacheLock comment to note the lock is held across the disk read in resolveReference (readLineFingerprint), and that this is an accepted tradeoff because concurrency in these tools is rare.
- No behavioral change.
- Dependency: none. Agent: coder.

### Step 5 — DEFERRED: coordinator spawn test isolation (drone-coordinator/test/routes/spawn.test.ts + drone-agent/test/mcp-client.test.ts)
File: drone-coordinator/test/routes/spawn.test.ts
- In the POST /spawn test, hold a direct reference to the mockFetch and assert on it (mockFetch.mock.calls) instead of `vi.mocked(fetch)` reading the global. This makes the test immune to global fetch pollution.
File: drone-agent/test/mcp-client.test.ts
- Replace `globalThis.fetch = mock.fetch` / `globalThis.fetch = GUARD_FETCH` with `vi.stubGlobal('fetch', mock.fetch)` / `vi.unstubAllGlobals()` so the mock is properly scoped and restored, preventing leakage into other files under singleFork.
- Dependency: none. Agent: coder. NOTE: do this AFTER the LSP front (Steps 1-4) is stable.

### Step 6 — validation
- LSP zero errors across all touched files.
- pnpm -r run build (drone-core types changed → rebuild before dependent typecheck).
- pnpm -r run lint zero errors.
- Fast test suite passes (pnpm test), especially lsp-ergonomics.test.ts and drone-coordinator/test/routes/spawn.test.ts.
- Run the full suite multiple times to confirm the flaky spawn/principles/insight failures are gone.

## Files touched
- drone-agent/src/plugins/lsp/tools/editing.ts
- drone-core/src/position-types.ts
- drone-agent/src/plugins/lsp/server.ts
- drone-agent/test/lsp-ergonomics.test.ts
- drone-coordinator/test/routes/spawn.test.ts (deferred)
- drone-agent/test/mcp-client.test.ts (deferred)

## Notes
- Step 5 is the pre-existing flaky test-isolation fix; it is required to merge the branch (the fast suite must pass reliably), but is deferred until the LSP front is stable.
- The symmetry finding (#5) corrects the review record: the code was already symmetric; only a regression test is needed.
- Step 2 decision: "anchor on the nearest unique line" — provably optimal, ordering-independent, simpler than a greedy trim loop.

## Validation criteria
- LSP diagnostics clean on all touched files.
- pnpm -r run build and pnpm -r run lint pass with zero errors.
- pnpm test passes, especially lsp-ergonomics.test.ts (all existing + new tests) and drone-coordinator/test/routes/spawn.test.ts.
- New tests: code_action query.filePath uses targetFilePath; code_action uses ref.range directly; suggestedContext minimal-block (nearest-unique-line anchoring); suggestedContext symmetry (odd n+1+n).
- Full suite passes reliably across multiple runs (flaky spawn/principles/insight failures resolved).
- No dead code or unused variables; new code covered by unit tests.