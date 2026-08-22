---
key: plan-semantic-search-prompt-adoption
tags:
  - plan
  - search
  - prompt-engineering
  - semantic-search
created: 2026-08-21T22:48:54.940Z
updated: 2026-08-21T22:49:40.740Z
---

# Plan: Make Semantic Search Discoverable & Enticing via Prompts

## Summary

The beacon-backed semantic search (`search__text` with `mode: "semantic"`) is fully functional, but agents never use it. Root cause is prompt surface, not capability: the tool description leads with regex and mentions semantic as a trailing afterthought, and the only prompt fragment (`search-indexed-directories`) is two sentences with no decision guidance. Contrast with the `# LSP Usage` fragment (drone-agent/src/plugins/lsp/plugin.ts:69), which demonstrably shapes agent behavior because it gives concrete when/why/how rules. This plan rewrites the prompt surface only — no runtime behavior changes, no reactive tool-output nudges (explicitly deferred). It also removes the dead legacy search plugin placeholder file (user-approved scope addition).

## Current State (facts verified 2026-08-21)

- Tool registration + description: `drone-agent/src/plugins/search/index.ts` lines ~44–49. Current text: "Regex/fixed-string search via ripgrep (falls back to grep). Returns file, line, content. Use mode=\"semantic\" for semantic (vector) search when a beacon connection is available."
- Prompt fragment registration: same file, lines ~206–216 (inside `onPluginsLoaded`, only when config `search.enabled`, swarm capability present, paths configured, and beacon PUT succeeds). Current render: `# Search Index` heading + one sentence + directory list.
- Legacy dead file `drone-agent/src/plugins/search.ts` (placeholder, description says "not yet implemented") — zero imports anywhere (verified by grep); not in `plugins/index.ts`.
- Tests: `drone-agent/test/search.test.ts` (479 lines). `captureRegistration()` mock has `registerPromptFragment: () => {}` (no-op) and `getConfig: () => createDefaultAgentConfig()` and `request: () => undefined`.
- Constraint from AGENTS.md: prompt fragments are sent as separate LLM messages and must start with a top-level `# Heading`.

## Steps

### Step 1 — Rewrite the `search__text` tool description

File: `drone-agent/src/plugins/search/index.ts` (the `description` field of the `registerTool` call, ~line 44).

Replace with copy that (a) leads with the two-mode framing, (b) gives concrete when-to-use-which rules, (c) explains the result shape difference (regex → file/line/content; semantic → file/score/snippet, follow up with `file__read`). Rough target:

```typescript
description:
  'Workspace text search with two modes. ' +
  'mode="regex" (default): literal/regex match via ripgrep — best when you know the exact identifier, string, or pattern. ' +
  'mode="semantic": vector similarity search via the beacon — best when searching by concept or intent ' +
  '(e.g. "where is rate limiting implemented?"), when you don\'t know the exact wording, ' +
  'or when a regex search returned zero or too many matches. ' +
  'Semantic results are file + score + snippet (no line numbers); follow up with file__read. ' +
  'Semantic mode requires a beacon connection; without one it returns an explanatory note.',
```

### Step 2 — Expand the `# Search Index` prompt fragment into real usage guidance

File: `drone-agent/src/plugins/search/index.ts`, the `render` of fragment key `search-indexed-directories` (~lines 209–216). Keep the top-level `# Search Index` heading and directory list; add a decision-rules section modeled on `# LSP Usage`. Rough target:

```
# Search Index
The following directories are indexed for semantic (vector) search — query them by
meaning rather than exact text:
  - <dir paths, as today>

When to use `search__text` with `mode: "semantic"` vs regex:
- Use semantic when searching by concept, behavior, or intent (e.g. "where is
  session expiry handled", "code that validates config") or when you don't know
  the exact identifier/wording used in the code.
- Use regex (default) when you know the exact symbol, string, or pattern.
- If a regex search returns zero results or an overwhelming number, retry the
  intent semantically.
Semantic results return file, score, and a content snippet (no line numbers);
read the file with `file__read` for full context. Lower `minScore` (e.g. 0.3) if
too few results; raise it to filter noise.
```

Note: the tool description (Step 1) and this fragment intentionally reinforce each other — description = always visible; fragment = visible only when semantic is actually wired to indexed dirs.

### Step 3 — Delete the dead legacy plugin file (user-approved)

Delete `drone-agent/src/plugins/search.ts` (placeholder, unreferenced — verified zero imports, not registered in `plugins/index.ts`). Required housekeeping per project standards ("dead code must be removed").

### Step 4 — Update tests (`drone-agent/test/search.test.ts`)

- Extend `captureRegistration()` to capture fragments: add a `fragments` map and implement `registerPromptFragment: fragment => fragments.set(fragment.key, fragment)`.
- New describe block "search plugin — prompt surface":
  - Tool description test: register plugin with the default mock config; assert the registered `text` tool's description mentions `semantic`, `regex`, and `file__read`. (Requires capturing the full tool object, not just `execute` — adjust the map value type or add a second map.)
  - Fragment test: mock `getConfig` to return a config with `search: { enabled: true, paths: [{ path: '/tmp/some-dir' }] }`, mock `request` to return a fake `DroneSwarmCapability` (`getBeaconUrl`, `getAgentId`), and stub `globalThis.fetch` (vi.stubGlobal) to return `{ ok: true, json: async () => ({ indexed: true, paths: ['/tmp/some-dir'] }) }` for the beacon PUT. Then assert:
    - fragment key `search-indexed-directories` was registered with `phase: 'header'`
    - rendered output starts with `# Search Index`
    - rendered output contains the directory path and `mode: "semantic"`
    - rendered output contains the decision guidance keywords (regex, concept, `file__read`, `minScore`)
- All existing tests in the file must still pass unchanged (they use default config → no fragment registered → unaffected).

### Step 5 — Validation

Run in order; all must pass with zero errors:

1. LSP diagnostics clean across the workspace (no new errors/warnings in touched files)
2. `pnpm -r run build`
3. `pnpm -r run lint`
4. `pnpm -r run test` (fast suite)

## Validation Criteria

- [ ] `search__text` tool description leads with two-mode framing and includes when-to-use guidance + result-shape note (verified by unit test).
- [ ] `search-indexed-directories` fragment renders `# Search Index` + directory list + decision rules (verified by unit test).
- [ ] Legacy `src/plugins/search.ts` deleted; no dangling imports (grep + build).
- [ ] LSP diagnostics pass; `pnpm -r run build`, `pnpm -r run lint`, `pnpm -r run test` all pass.
- [ ] No runtime/search behavior changed (regex and semantic execution paths untouched).

## Explicit Non-Goals (deferred)

- Reactive nudges in regex tool output (e.g. "0 results — try semantic") — deliberately excluded from this phase.
- Any changes to beacon, indexing, chunking, or config.
- Per-persona prompt tuning.

## Housekeeping for the executing agent

Per AGENTS.md, `.drone-agent/` contents (including this memory) are checked into VCS on feature branches — commit this memory with the change set. Log a `self-improvement` insight after landing if real-session behavior change is observed (or not) in follow-up use.
