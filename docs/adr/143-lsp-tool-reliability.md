---
tags: [decision, lsp, ergonomics, reliability]
related: [concepts/lsp-symbolic-resolution.md, decisions/069-lsp-ergonomics.md, decisions/136-lsp-symbolic-resolution.md, modules/drone-agent-plugins.md]
---

# 143: LSP Tool Reliability — Call-Hierarchy Cross-Check & Symbols Exact-First + Dedup

**Status**: Implemented (2026-08-17)

## Context

Three LSP-tool defects surfaced while exercising the tools against real code:

1. **`call_hierarchy` silently returns empty** `from`/`to` even when callers/callees exist (typescript-language-server flakiness for local functions). The LLM had no way to tell "genuinely unreferenced" from "empty-but-referenced".
2. **`symbols` workspace search includes near-matches** even when exact matches exist, and returns **duplicate entries** (4x) for the same location — near matches drowned out exact hits.
3. Tool descriptions + a new prompt fragment should teach the `text`-vs-`symbol` distinction, the call-hierarchy reliability caveat, and the symbols noise warning.

## Decision

### 1. `call_hierarchy` cross-check (hierarchy.ts)

When the hierarchy result for the requested direction is empty, issue a `textDocument/references` request (`includeDeclaration: false`) on the same runtime/document/position. Normalize + dedup the locations (by `filePath, line, column`), capped at `REFERENCES_CAP` (50). If references are found, add:

- `warning` — human-readable string, e.g. `callHierarchy/incomingCalls returned no callers, but textDocument/references found N references — the hierarchy result may be incomplete. See "references".`
- `references` — the agent-shaped location array.

Applies to BOTH directions (incoming and outgoing). The happy path (non-empty hierarchy) is unchanged — no extra LSP round-trip.

### 2. `symbols` exact-first + dedup (symbols.ts)

Extracted a shared `filterSymbolsByQuery(symbols, query)` helper (in `normalize/symbols.ts`): exact `name === query` matches win; prefix (`startsWith`) matches are only used when there are zero exacts. Reused in both `tools/symbols.ts` `executeWorkspaceSymbols` and `server.ts` `resolveSymbolPosition` (document + workspace symbol paths). Added `dedupeSymbols` keyed on `(filePath, line, column)`.

### 3. `lsp-usage` prompt fragment (plugin.ts)

Registered a header-phase fragment (key `lsp-usage`) alongside `lsp-status`, teaching:
- Prefer `symbol` over `text` (text is a raw substring search, ambiguous for reused symbols); use `surroundingText` to disambiguate.
- `call_hierarchy` can return empty results even when callers/callees exist; check `warning`/`references` or verify with `find_references`.
- Prefer `symbols` with `scope: "document"` when the target file is known; workspace search is exact-first + deduped — set `limit` and expect to filter.

Tool descriptions for `call_hierarchy` and `symbols` were updated to match.

## Key Points

- The cross-check is lazy — it only fires on empty results, so the happy path adds no round-trip.
- `filterSymbolsByQuery` is shared between the tool and position-resolution, avoiding duplication.
- The `lsp-usage` fragment is header-phase, so it's injected into the system prompt for every session.

## Related

- lsp-symbolic-resolution — The symbolic resolution layer
- [069-lsp-ergonomics](069-lsp-ergonomics.md) — Prior LSP ergonomics (text/symbol resolution)
- [136-lsp-symbolic-resolution](136-lsp-symbolic-resolution.md) — `AmbiguousPositionError`, reference ID handshake, auto-expansion
- [drone-agent-plugins](../../drone-agent/src/plugins/) — The LSP plugin tool surface
