---
key: plan-lsp-symbolic-resolution-followups
tags:
  []
created: 2026-08-17T22:04:29.158Z
updated: 2026-08-17T22:08:39.517Z
---

# Plan: LSP symbolic-resolution follow-up fixes

## Summary
Four follow-up fixes to the LSP symbolic-resolution work (surroundingText disambiguation, auto-expansion, reference IDs) found during review of branch `feat/lsp-symbolic-resolution-improvements`. Fixes a redundant double-parse in code_action, normalizes the mixed 1-based/0-based range convention at the agent boundary, reverts a dedup regression in buildAutoExpansion, and re-scopes the reference-cache lock (done last).

## Issues & agreed fixes

1. **code_action double-parses unambiguous text** — the ambiguity pre-pass (editing.ts ~182-191) calls parsePositionInput, discards the result, and only catches AmbiguousPositionError. The text/symbol branch (~247-255) does the exact same thing. For symbol resolution this is a wasted textDocument/documentSymbol LSP round-trip + file read on every code_action call. Fix: delete the pre-pass. The text/symbol branch already reports ambiguity with reference IDs, so nothing is lost.

2. **Mixed 1-based/0-based range convention** — locationToAgentShape returns 1-based line/column but 0-based range in the same object; code_action's query.range is 0-based. The LLM sees `line: 5` next to `range.start.line: 4`. Fix: normalize range to 1-based ONLY at the JSON boundary (locationToAgentShape + code_action query). Keep ReferenceLocation.range 0-based internally so code_action's referenceId branch still feeds raw LSP coords to the server.

3. **buildAutoExpansion dedup regression** — round-2 deduped by file (seenFiles); current code dedupes by position (seenKeys), so find_references with 5 hits in one file reads 5 snippets. Fix: revert to file-level dedup. Add a regression test asserting one-snippet-per-file. LOG AS SETTLED DECISION for the project wiki (this is the 2nd time it's flipped).

4. **Per-key reference lock (DO LAST)** — the withCacheLock mutex is a single session-global promise-chain; resolveReference holds it across readLineFingerprint (stat+readFile), so one slow disk read blocks all reference ops. Re-scope to a per-referenceId lock (Map<string, Promise>), holding the lock only around the Map mutation, not the disk read (readLineFingerprint before acquiring lock). This is hardening, not correctness — the practical win is small (tools are usually called sequentially) — so it is the LAST step and lowest priority. If it proves risky or time-consuming, it may be deferred with a note in the wiki.

## Steps

### Step 1 — Delete code_action pre-pass (editing.ts)
File: drone-agent/src/plugins/lsp/tools/editing.ts
- Delete the `if (!input.referenceId && (typeof input.text === 'string' || typeof input.symbol === 'string'))` pre-pass block (lines ~182-191) that calls parsePositionInput and catches AmbiguousPositionError.
- The text/symbol branch (~247-255) already handles ambiguity identically.
- Verify no behavior change: code_action with ambiguous text still returns reference IDs via buildAmbiguousResponse.
- Dependency: none. Agent: coder.

### Step 2 — Normalize range to 1-based at agent boundary
Files: drone-agent/src/plugins/lsp/server.ts, drone-agent/src/plugins/lsp/tools/editing.ts
- server.ts `locationToAgentShape`: map each location's range to 1-based (start.line+1, start.character+1, end.line+1, end.character+1). Keep line/column as-is (already 1-based).
- editing.ts code_action query (~line 391): `query: { filePath: targetFilePath, range }` → normalize range to 1-based in the query object.
- DO NOT change ReferenceLocation.range (0-based) — code_action's referenceId branch uses ref.range directly as the LSP request range.
- Add a test asserting locationToAgentShape returns 1-based range, and code_action query.range is 1-based.
- Dependency: none. Agent: coder.

### Step 3 — Revert buildAutoExpansion to file-level dedup + regression test
File: drone-agent/src/plugins/lsp/tools/navigation.ts, drone-agent/test/lsp-ergonomics.test.ts
- navigation.ts buildAutoExpansion: replace `seenKeys` (keyed on `${filePath}:${line}:${column}`) with `seenFiles` (keyed on filePath). Read one snippet per file.
- Add a regression test: find_references/go_to with multiple locations in the SAME file returns exactly one snippet for that file (assert snippets keys all have distinct filePaths).
- Log the settled decision (one-snippet-per-file) for the project wiki step.
- Dependency: none. Agent: coder.

### Step 4 — Per-key reference lock (DO LAST, lowest priority)
File: drone-agent/src/plugins/lsp/server.ts
- Re-scope withCacheLock from a single session-global promise-chain to a per-referenceId lock (Map<string, Promise>), so unrelated references resolve concurrently.
- Hold the lock only around the Map mutation, not the disk read (readLineFingerprint before acquiring lock).
- This is hardening, not correctness. Do it LAST. If it proves risky/time-consuming, defer with a note in the wiki.
- Dependency: Steps 1-3 (do after). Agent: coder.

### Step 5 — Validation
- LSP diagnostics clean on all touched files (server.ts, editing.ts, navigation.ts, lsp-ergonomics.test.ts).
- pnpm -r run build and pnpm -r run lint pass with zero errors.
- pnpm test passes, especially lsp-ergonomics.test.ts (all existing + new tests).
- New tests: locationToAgentShape 1-based range; code_action query.range 1-based; buildAutoExpansion one-snippet-per-file.
- No dead code or unused variables; new code covered by unit tests.

## Files touched
- drone-agent/src/plugins/lsp/tools/editing.ts
- drone-agent/src/plugins/lsp/server.ts
- drone-agent/src/plugins/lsp/tools/navigation.ts
- drone-agent/test/lsp-ergonomics.test.ts

## Notes
- Fix 2 is the subtle one: normalize at the JSON boundary only, keep ReferenceLocation.range 0-based internally (code_action referenceId branch feeds it to the LSP server).
- Fix 3 is a settled decision (one-snippet-per-file) — must be logged in the project wiki at the end.
- Fix 4 is done LAST and is lowest priority (hardening, not correctness); may be deferred with a wiki note.

## Validation criteria
- LSP diagnostics clean on all touched files.
- pnpm -r run build and pnpm -r run lint pass with zero errors.
- pnpm test passes, especially lsp-ergonomics.test.ts.
- New tests: locationToAgentShape 1-based range; code_action query.range 1-based; buildAutoExpansion one-snippet-per-file.
- Settled decision (one-snippet-per-file) logged in project wiki.
- No dead code or unused variables; new code covered by unit tests.