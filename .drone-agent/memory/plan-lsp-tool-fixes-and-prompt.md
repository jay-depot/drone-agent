---
key: plan-lsp-tool-fixes-and-prompt
tags:
  []
created: 2026-08-17T22:40:03.284Z
updated: 2026-08-17T22:47:35.286Z
---

# Plan: LSP tool reliability fixes + usage prompt fragment

## Summary
Three LSP-tool defects surfaced while exercising the tools against real code, plus a prompt-fragment improvement. (1) `call_hierarchy` silently returns empty `from`/`to` even when callers/callees exist (typescript-language-server flakiness for local functions). (2) `symbols` workspace search includes near-matches even when exact matches exist, and returns duplicate entries (4x) for the same location. (3) Tool descriptions + a new prompt fragment should teach agents the `text`-vs-`symbol` distinction, the call-hierarchy reliability caveat, and the symbols noise warning.

## Files
- `drone-agent/src/plugins/lsp/tools/hierarchy.ts` — call-hierarchy cross-check
- `drone-agent/src/plugins/lsp/tools/symbols.ts` — exact-first + dedup
- `drone-agent/src/plugins/lsp/server.ts` — optional shared exact-then-prefix helper
- `drone-agent/src/plugins/lsp/plugin.ts` — new `lsp-usage` prompt fragment
- `drone-agent/test/lsp-ergonomics.test.ts` — mock-server tests
- `drone-agent/test/lsp-fake-server.ts` — wire-level test (optional)

## Steps

### Step 1 — Call-hierarchy cross-check (hierarchy.ts)
In `createCallHierarchyTool.execute`, after `normalizeCallHierarchyCalls(calls)`:
- Compute the result array for the requested direction (`from` for incoming, `to` for outgoing).
- If that array is empty, issue `textDocument/references` on the same `runtime`/`document`/position with `context: { includeDeclaration: false }`.
- Normalize via `normalizeLspLocation`, then `server.locationToAgentShape(...)`.
- Dedup by `(filePath, line, column)`; cap at 50.
- If references found, add to the result:
  - `warning`: human-readable string, e.g. `callHierarchy/incomingCalls returned no callers, but textDocument/references found N references — the hierarchy result may be incomplete. See "references".`
  - `references`: the agent-shaped location array.
- Happy path (non-empty hierarchy) unchanged — no extra LSP round-trip.
- Apply to BOTH directions (incoming and outgoing).

### Step 2 — Update call_hierarchy tool description (hierarchy.ts)
Mention that empty results may be cross-checked against references and that a `warning` + `references` field may appear.

### Step 3 — Symbols exact-first + dedup (symbols.ts)
In `executeWorkspaceSymbols`, after flattening across servers (`flat`):
- Filter to exact `name === query` matches. If any exist, use only those.
- Else fall back to prefix `name.startsWith(query)` matches.
- Dedup by `(filePath, line, column)` (collapse identical locations).
- Then sort, apply `limit`, and return as before.
- Consider extracting a shared helper (e.g. `filterSymbolsByQuery(symbols, query)`) if the exact-then-prefix logic is reusable with `resolveSymbolPosition` in `server.ts` — reuse over duplication.

### Step 4 — Update symbols tool description (symbols.ts)
- Replace "fuzzy matching" with exact-match-first + prefix fallback.
- Note results are deduped.
- Clarify `limit` is workspace-scope only (ignored in document scope).

### Step 5 — Add `lsp-usage` prompt fragment (plugin.ts)
Register a separate header-phase fragment (key `lsp-usage`) alongside `lsp-status`. Content (starts with `# LSP Usage`):
- Prefer `symbol` over `text` for symbol names (`text` is a raw substring search and matches call sites → ambiguous for reused symbols). Use `surroundingText` to disambiguate.
- `call_hierarchy` can return empty `from`/`to` even when callers/callees exist; if a result looks suspiciously empty, verify with `find_references` (or check the `warning`/`references` fields).
- Prefer `symbols` with `scope: "document"` when the target file is known; workspace-scope search is exact-first with prefix fallback and is deduped — set `limit` and expect to filter.

### Step 6 — Tests (lsp-ergonomics.test.ts)
- **Call hierarchy:** mock `ServerManager` where `callHierarchy/incomingCalls` returns empty but `textDocument/references` returns locations → assert `warning` + `references` present, references deduped/capped. Assert happy path (non-empty hierarchy) does NOT trigger the references request.
- **Symbols:** mock `ServerManager` where `workspace/symbol` returns a mix of exact + near matches + duplicates → assert exact matches win, near matches excluded when exacts exist, duplicates collapsed. Assert prefix fallback when zero exacts.
- **Optional wire-level:** in `lsp-fake-server.ts`-based test, assert the `textDocument/references` request is actually sent when hierarchy is empty.

## Validation criteria
- LSP passes (typescript) with zero errors on all touched files.
- `pnpm -r run lint` and `pnpm -r run build` pass with zero errors.
- `pnpm -r run test` (fast suite) passes, including new tests in `lsp-ergonomics.test.ts`.
- New behavior verified: call_hierarchy returns `warning`+`references` on empty-but-referenced results; symbols returns exact-first, deduped results.
- No dead code, no unused vars, no fluff comments. Comments only for complex logic or TODO/FIXME.
- Files stay under 750 lines (hierarchy.ts ~117 → fine; symbols.ts ~156 → fine; server.ts is 1665 but not being split in this plan).

---

## EXECUTION SUMMARY (2026-08-17)

All steps completed and committed (commit `0fc6d5c`).

### What was done
- **Step 1 (call_hierarchy cross-check):** In `hierarchy.ts`, when the requested direction's result array is empty, issue `textDocument/references` with `includeDeclaration: false`, normalize via `normalizeLspLocation` + `server.locationToAgentShape`, dedup by `(filePath, line, column)` capped at 50 (`REFERENCES_CAP`). On found references, add `warning` (human-readable string) + `references` (agent-shaped locations). Both directions; happy path unchanged (no extra round-trip).
- **Step 2 (description):** `call_hierarchy` description now mentions the cross-check and the `warning`/`references` fields.
- **Step 3 (symbols exact-first + dedup):** Added shared `filterSymbolsByQuery(symbols, query)` helper in `normalize/symbols.ts` (exact `name === query` wins; prefix `startsWith` fallback only when zero exacts). Reused in both `tools/symbols.ts` `executeWorkspaceSymbols` and `server.ts` `resolveSymbolPosition` (both document-symbol and workspace-symbol paths). Added `dedupeSymbols` in `tools/symbols.ts` keyed on `(filePath, line, column)`.
- **Step 4 (description):** `symbols` description now says exact-match-first + prefix fallback, deduped by location; `limit` clarified as workspace-only.
- **Step 5 (prompt fragment):** Added `lsp-usage` header-phase fragment in `plugin.ts` with the text-vs-symbol guidance, call_hierarchy reliability caveat, and symbols noise warning.
- **Step 6 (tests):** Added 5 tests in `lsp-ergonomics.test.ts`: call_hierarchy adds warning+references when empty-but-referenced; call_hierarchy does NOT cross-check on non-empty; symbols exact-first; symbols prefix fallback; symbols dedup.

### Verification
- LSP (typescript) clean — zero errors on all touched files and workspace-wide.
- `pnpm -r run build` passes.
- `pnpm lint` (eslint + prettier) passes.
- `pnpm test` passes: 1954 passed, 9 skipped (integration-gated), including the 5 new tests (55 total in lsp-ergonomics.test.ts).

### Notes / deviations
- The plan's "optional wire-level test" (lsp-fake-server.ts) was NOT added — the mock-server tests in lsp-ergonomics.test.ts cover the behavior adequately and the plan marked it optional.
- A stale/broken `filterSymbolsByQuery` import from `drone-core` was found in `server.ts` (pre-existing, surfaced as LSP errors) and removed; the correct import is from `./normalize/index.js`.
- Prettier reformatted the plan memory markdown (cosmetic only).