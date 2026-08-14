---
key: plan-search-files-slash-command
tags:
  []
created: 2026-08-14T04:16:27.667Z
updated: 2026-08-14T04:16:27.667Z
---

---
key: plan-search-files-slash-command
tags: []
created: 2026-08-14T04:05:00.000Z
updated: 2026-08-14T04:05:00.000Z
---

# Plan: `/search-files` slash command (human-friendly search wrapper)

## Summary

Add a `/search-files` slash command to the `search` plugin that gives the user a human-friendly interface to the same `search__text` tool the LLM uses. It supports both regex (default) and semantic (vector) modes. The primary use case is letting the user run semantic queries and eyeball the results to evaluate how well the current chunking rules work — so the semantic output surfaces the matching chunk snippet (query-aware) rather than dumping whole files.

The command is a thin wrapper: it parses flags, calls `ctx.engine.executeTool('search__text', {...})`, and formats the JSON result for display. No beacon API changes. No chunking control (chunking tweaks are code changes + reindex, out of scope).

## Design decisions

1. **Command name:** `/search-files` — explicitly filesystem-scoped, leaving a natural sibling (e.g. `/search-wiki` or `/search-memory`) for the future swarm-memory-wiki search. Avoids ambiguity.
2. **Location:** registered in the `search` plugin (`drone-agent/src/plugins/search/index.ts`), so it's gated by the plugin being enabled (`defaultEnabled: false`). No special-casing.
3. **Dual mode:** wraps `search__text`, which already supports `mode: "regex"` (default) and `mode: "semantic"`. Regex is local (ripgrep/grep); semantic proxies to the beacon when swarm is connected.
4. **Flag-based args:** `/search-files <pattern> [--semantic] [--path <dir>] [--limit N] [--glob <g>]`. Defaults: `path`=CWD, `limit`=10, `glob`=null. No `--min-score`/`--fixed` (niche; min-score is for the LLM to filter noise — the user wants to see low-score noise to spot problems).
5. **Execution:** reuse the tool via `ctx.engine.executeTool('search__text', {...})` — reuses all existing logic (swarm capability, exclude handling, ripgrep detection) for free.
6. **Regex output:** `file:line` list with the matched line content (the tool already returns `file`/`line`/`content`).
7. **Semantic output:** file + score + query-aware ~200-char snippet. Snippet extraction is a local pure function in the plugin (display concern only; beacon API unchanged). Isolated behind a small helper so a stemmer (lancaster-stemmer, planned) can slot in later without touching command logic.
8. **No-beacon semantic:** friendly message (the tool returns a JSON note; surface it nicely).
9. **Help:** registered via `registration.registerHelp(...)`.

## Snippet algorithm (semantic mode)

- Tokenize query into terms (lowercased, split on non-alphanumeric).
- Split chunk into sentences (on `.`, `!`, `?`, newlines).
- Score each sentence by count of distinct query terms present (case-insensitive substring match).
- Pick the highest-scoring sentence; if > ~200 chars, trim to a window around the first matched term with `…` prefix/suffix; else show whole.
- Isolate behind a helper (e.g. `extractSnippet(query, chunkText): string`) so a stemmer can be swapped in later.

## Steps

### Step 1 — Add snippet helper + flag parser to the search plugin
**File:** `drone-agent/src/plugins/search/index.ts`

- Add a pure `extractSnippet(query: string, chunkText: string, maxLen = 200): string` function (query-aware sentence selection + windowing).
- Add a `parseSearchFilesArgs(args: string[])` helper that parses `--semantic`, `--path <dir>`, `--limit N`, `--glob <g>` from `ctx.args`, returning `{ pattern, mode, path, limit, glob }` with defaults (`path`=CWD, `limit`=10, `glob`=null). Unknown flags → usage error.

### Step 2 — Register the `/search-files` slash command
**File:** `drone-agent/src/plugins/search/index.ts`

In `register()`, add `registration.registerSlashCommand({ command: '/search-files', description: 'Search files: regex (default) or semantic (--semantic)', handler })`.

Handler logic:
1. Parse args via `parseSearchFilesArgs(ctx.args)`. If no pattern or bad flags, print usage and return `true`.
2. Build the tool input: `{ pattern, mode, path, maxResults: limit, glob }` (omit `glob` when null).
3. Call `ctx.engine.executeTool('search__text', input)`.
4. Parse the returned JSON.
5. **Regex mode:** format as `file:line` list with matched line content.
6. **Semantic mode:** for each result, compute `extractSnippet(query, result.content)` and print `score  file` + indented snippet. Handle the no-beacon note case with a friendly message.
7. Print results via `ctx.logger.info(...)` (multi-line string). Return `true`.

Also add `registration.registerHelp('/search-files <pattern> [--semantic] [--path <dir>] [--limit N] [--glob <g>]')`.

### Step 3 — Tests
**File:** `drone-agent/test/search.test.ts`

- **Flag parser:** `parseSearchFilesArgs` handles `--semantic`, `--path`, `--limit`, `--glob`, defaults, and unknown-flag errors.
- **Snippet extraction:** `extractSnippet` picks the sentence with most query-term overlap; trims long sentences to a window; handles no-overlap (falls back to first sentence).
- **Regex output formatting:** mock `ctx.engine.executeTool` returning a regex result; assert `file:line` + content formatting.
- **Semantic output formatting:** mock `executeTool` returning a semantic result with a long chunk; assert score + snippet output.
- **No-beacon semantic:** mock `executeTool` returning the no-beacon note; assert friendly message.

### Step 4 — Validation
1. LSP diagnostics clean for all touched files (note pre-existing branch diagnostics: `drone-agent/test/search.test.ts` `Cannot find module 'drone-swarm-common'`, `prompt-file.test.ts` config-type error — do not introduce NEW diagnostics).
2. `pnpm -r run build` passes.
3. `pnpm -r run typecheck` passes.
4. `pnpm -r run lint` passes.
5. `pnpm -r run test` passes.
6. Manual smoke: `/search-files "foo"` (regex), `/search-files "how does compaction work" --semantic` (semantic), `/search-files` (usage), `/search-files "x" --semantic` without beacon (friendly message).

**Validation criteria:** all six checks green, no new LSP errors in touched files.

## Future work (not in this plan)
- Swap lancaster-stemmer into `extractSnippet` term matching.
- A sibling `/search-wiki` (or `/search-memory`) command for the swarm-memory-wiki search.
- `--min-score`/`--fixed` flags if needed later.
