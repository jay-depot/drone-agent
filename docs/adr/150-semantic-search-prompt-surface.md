---
tags: [decision, search, semantic-search, prompt-engineering]
related:
  [
    concepts/semantic-search.md,
    modules/drone-agent-plugins.md,
    decisions/127-semantic-search-beacon.md,
    decisions/143-lsp-tool-reliability.md,
  ]
---

# 150: Semantic search discoverability via prompt surface (not runtime nudges)

**Status**: Implemented (2026-08-21)

## Context

The beacon-backed semantic search (`search__text` with `mode: "semantic"`) was fully functional but effectively unused by agents. The root cause was the **prompt surface**, not capability:

- The tool description **led with regex** and mentioned semantic mode only as a trailing afterthought: _"Regex/fixed-string search via ripgrep (falls back to grep). Returns file, line, content. Use mode="semantic" for semantic (vector) search when a beacon connection is available."_ An agent skimming its tool list gets no signal about _when_ to prefer semantic mode or what it returns.
- The only prompt fragment (`search-indexed-directories`, registered only when `search.enabled` + swarm connected + beacon PUT succeeds) was two sentences listing indexed directories — no decision guidance at all.

The counter-example that proved the fix: the `# LSP Usage` header fragment (`drone-agent/src/plugins/lsp/plugin.ts`) demonstrably shapes agent behavior because it gives concrete **when/why/how** rules rather than just naming a capability.

## Decision

Rewrite the prompt surface only — no runtime behavior changes. Two reinforcing surfaces:

1. **Tool description** (`search__text`): leads with two-mode framing, gives concrete when-to-use-which rules (semantic for concept/intent queries or unknown wording or after zero/too-many regex hits; regex for exact identifiers), and explains the result-shape difference (regex → file/line/content; semantic → file/score/snippet, follow up with `file__read`). The description is **always visible**, even without a beacon.

2. **`search-indexed-directories` fragment**: keeps the top-level `# Search Index` heading + directory list (per AGENTS.md fragments must start with a top-level heading since they arrive as separate LLM messages), and adds a decision-rules section modeled on `# LSP Usage`: semantic-vs-regex guidance, the retry-semantically-on-zero-or-overwhelming-results rule, the `file__read` follow-up convention, and `minScore` tuning (lower to ~0.3 if too few results). This fragment is visible **only when semantic search is actually wired to indexed directories** — description and fragment intentionally reinforce each other.

3. **Housekeeping**: deleted the dead legacy placeholder `drone-agent/src/plugins/search.ts` ("not yet implemented" stub with zero imports, not registered in `plugins/index.ts`) per the "dead code must be removed" standard (user-approved scope addition).

### Explicitly rejected/deferred

- **Reactive nudges in regex tool output** (e.g. "0 results — try semantic") — deliberately excluded from this phase; the prompt surface alone may suffice, and output-shape changes are a runtime concern.
- Any changes to beacon, indexing, chunking, or config; per-persona prompt tuning.

## Consequences

- No runtime/search behavior changed — regex and semantic execution paths are untouched (strings-only source diff).
- Agents always see the two-mode framing via the tool description; agents on swarm-connected setups additionally get the full decision rules once indexing succeeds.
- Effectiveness is unverified until observed in real sessions — a follow-up insight should be logged if adoption does (or doesn't) change.

## Tests

`drone-agent/test/search.test.ts` gained a "prompt surface" describe block:

- `captureRegistration()` extended to capture full `DroneToolDefinition`s, prompt fragments by key, **and** the `onPluginsLoaded` callback (exposed as `runOnPluginsLoaded()`) — necessary because fragment registration happens inside that hook, which the old mock discarded.
- Description test: asserts the registered `text` tool's description mentions `semantic`, `regex`, and `file__read`.
- Fragment test: mocks config (`search.enabled` + one path), a fake `DroneSwarmCapability`, and stubs `fetch` for the beacon PUT; asserts key `search-indexed-directories` registers with `phase: 'header'`, render starts with `# Search Index`, contains the directory path and `mode: "semantic"`, and contains the decision-guidance keywords (regex, concept, `file__read`, `minScore`).
- All pre-existing tests unchanged (default mock config → no fragment registered → unaffected).

## Implementation

- **Commit**: `17c59c6` ("feat(search): make semantic search discoverable via prompt surface")
- **Files**: `drone-agent/src/plugins/search/index.ts` (description + fragment strings), `drone-agent/src/plugins/search.ts` (deleted), `drone-agent/test/search.test.ts`
- **Validation**: LSP diagnostics clean in touched files (workspace baseline unchanged); `pnpm -r run build` clean; root `pnpm lint` clean; fast suite 1991 passed / 9 skipped / 0 failed (130 files).

## Related

- semantic-search — the full semantic-search architecture this prompt surface advertises
- [drone-agent-plugins](../../drone-agent/src/plugins/) — the `search` plugin row
- [127-semantic-search-beacon](127-semantic-search-beacon.md) — semantic search moved to the beacon
- [143-lsp-tool-reliability](143-lsp-tool-reliability.md) — introduced the `lsp-usage` fragment, the model for decision-rule fragments
