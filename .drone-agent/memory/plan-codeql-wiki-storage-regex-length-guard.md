---
key: plan-codeql-wiki-storage-regex-length-guard
tags: []
created: 2026-08-14T18:22:40.157Z
updated: 2026-08-14T18:22:40.157Z
---

# Plan: CodeQL — polynomial regex on uncontrolled data in wiki-storage.ts

## Summary

CodeQL flags `drone-swarm-common/src/wiki-storage.ts:98` — the regex `/\[\[([^\]]+)\]\]/g` in `extractWikiLinks()` — as "Polynomial regular expression used on uncontrolled data". `content` (markdown page body) is user-supplied and flows into the regex from both `writePage()` and `lintPages()`. The regex is actually linear, but per project convention (see insight 2026-08-14T15:39:38.979Z) the minimal, behavior-preserving mitigation is a length cap on the input BEFORE the regex runs, rather than rewriting the regex or adding a suppression comment. This bounds the polynomial match to a fixed-size input. Add a unit test for the guard.

## Established pattern (done today, same package)

`search-provider-ollama.ts` `createOllamaEmbeddingProvider`:

```ts
const rawHost = config.host.trim();
if (rawHost.length > 2048) {
  throw new Error(`Ollama host URL exceeds maximum length: ${rawHost.length}`);
}
const host = rawHost.replace(/\/+$/, '');
```

Test in `search-provider-ollama.test.ts`: rejects over-long host, accepts at-limit host.

## Behavior decisions (locked with user)

- Cap value: 1,000,000 chars (1MB) — generous, far beyond any real wiki page; purely a safety bound.
- `writePage`: THROW on over-length content (reject the write).
- `lintPages`: ACCEPT long pages (no throw). lintPages has NO "warnings" concept today (returns only `{ issues }`), and we are NOT adding warnings in this branch. So the lint path degrades gracefully (skips link extraction for the oversized page).
- NOTE for a separate feature push: add a "warnings" concept to wiki lint, including an "excessively long page" warning, which could optionally trigger an automatic page-splitting process.

## Steps

1. `drone-swarm-common/src/wiki-storage.ts` — add module-level constant `const MAX_WIKI_CONTENT_LENGTH = 1_000_000;`. In `extractWikiLinks(content)`, add a guard at the top: `if (content.length > MAX_WIKI_CONTENT_LENGTH) throw new Error(...)`. This places the guard where the regex runs, satisfying CodeQL for BOTH callers.
2. `lintPages()` — wrap the `extractWikiLinks(page.content)` call in try/catch; on the over-length error, `continue` (skip link extraction for that page) so lint tolerates oversized pages. (writePage keeps the throw.)
3. Tests in `drone-swarm-common/test/wiki-storage.test.ts`:
   - `writePage` with content > 1MB rejects with the length error.
   - `writePage` with content at the 1MB limit succeeds (boundary).
   - `lintPages` with an oversized page does NOT throw and still returns issues for other pages (graceful degradation).
4. Validation: LSP zero errors; `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes.

## Files touched

- drone-swarm-common/src/wiki-storage.ts
- drone-swarm-common/test/wiki-storage.test.ts

## Notes

- No drone-core changes → no cross-package rebuild needed before typecheck, but run `pnpm -r run build` as part of validation anyway.
- Record an insight noting the future lint-warnings feature (long-page warning + optional auto-split).
