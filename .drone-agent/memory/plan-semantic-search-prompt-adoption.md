---
key: plan-semantic-search-prompt-adoption
tags:
  - plan
  - search
  - prompt-engineering
  - semantic-search
created: 2026-08-21T22:48:54.940Z
updated: 2026-08-21T23:13:20.892Z
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
- [x] `search__text` tool description leads with two-mode framing and includes when-to-use guidance + result-shape note (verified by unit test).
- [x] `search-indexed-directories` fragment renders `# Search Index` + directory list + decision rules (verified by unit test).
- [x] Legacy `src/plugins/search.ts` deleted; no dangling imports (grep + build).
- [x] LSP diagnostics pass; `pnpm -r run build`, `pnpm -r run lint`, `pnpm -r run test` all pass.
- [x] No runtime/search behavior changed (regex and semantic execution paths untouched).

## Explicit Non-Goals (deferred)
- Reactive nudges in regex tool output (e.g. "0 results — try semantic") — deliberately excluded from this phase.
- Any changes to beacon, indexing, chunking, or config.
- Per-persona prompt tuning.

## Housekeeping for the executing agent
Per AGENTS.md, `.drone-agent/` contents (including this memory) are checked into VCS on feature branches — commit this memory with the change set. Log a `self-improvement` insight after landing if real-session behavior change is observed (or not) in follow-up use.

---

## Execution Summary (2026-08-21, executed by `code` persona)

**Status: COMPLETE. All steps executed; all validation criteria pass.**

What was done:
1. **Tool description rewritten** exactly per plan target copy (two-mode lead, when-to-use rules, result-shape note, beacon requirement note).
2. **Fragment expanded** per plan target copy: kept `# Search Index` heading + dir list; appended decision-rules block (semantic vs regex guidance, retry-semantically-on-zero/too-many rule, `file__read` follow-up, `minScore` tuning tip).
3. **Legacy `src/plugins/search.ts` deleted** (`git rm`; staged). Zero references confirmed pre-deletion via grep.
4. **Tests updated**: `captureRegistration()` now captures full `DroneToolDefinition`s, fragments by key, AND the `onPluginsLoaded` callback (exposed as `runOnPluginsLoaded()` — necessary because fragment registration happens inside that hook, which the old mock discarded). Existing tests adjusted minimally (`tools.get('text')?.execute`). New describe block `search plugin — prompt surface` with 2 tests covering description keywords and full fragment render assertions (phase, heading, dir path, decision-guidance keywords incl. `minScore`).
5. **Validation**: LSP diagnostics clean in both touched files (workspace baseline unchanged); `pnpm -r run build` ✅; lint ✅; fast suite ✅ 1991 passed / 9 skipped / 0 failed (130 files).

Deviations/notes (best judgement within plan intent):
- Plan's literal commands `pnpm -r run lint` / `pnpm -r run test` don't work as written: lint lives only at the workspace root (`pnpm lint` = eslint --fix + prettier --write), and `pnpm -r run test` fails structurally in ALL packages (every package has `"test": "vitest run"` but none ships its own vitest config, so each inherits the ROOT vitest.config.ts whose include globs are repo-root-relative and match nothing from a package cwd → vitest exits 1 "No test files found"). Verified pre-existing via `git stash` + rerun on clean tree. Used root `pnpm lint` and root `pnpm test` (the actual supported fast-suite entrypoint) as equivalents. Logged as project insight — candidate follow-up fix.
- One transient defect caught and fixed mid-flight: initial fragment hunk left `,` instead of `+` between template-literal concatenation lines inside the arrow function (syntactically invalid). Caught by reading back the region + LSP diagnostics before proceeding.
- First test run failed because the new fragment test initially omitted `await searchPlugin.register(registration)` (hook callback was never captured). Fixed; suite fully green afterward.
- Prettier (via `pnpm lint`) reformatted `.drone-agent/memory/plan-semantic-search-prompt-adoption.md` (heading spacing) and `.drone-agent/insights/project/drone-agent.json` (trailing newline) — benign, checked in intentionally per AGENTS.md.

Follow-up candidates (explicitly deferred by plan): reactive "try semantic" nudges in regex output; fixing per-package `test` scripts / adding package-local vitest configs so `pnpm -r run test` works; observe real-session semantic-search adoption and log an insight if behavior changed.