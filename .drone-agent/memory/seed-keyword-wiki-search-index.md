---
key: seed-keyword-wiki-search-index
tags:
  - seed
  - planning
  - wiki
  - search
  - performance
  - sqlite-fts5
  - drone-swarm-common
  - drone-beacon
  - deferred
created: 2026-10-20T23:51:17.813Z
updated: 2026-10-20T23:51:17.813Z
---

# Seed: give the keyword wiki search a real index (deferred follow-up)

**Status**: idea only, not planned or scoped. Deliberately deferred 2026-10-20 when
`swarm__wiki_search` was repointed to `/wiki/semantic-search`.

## Context

`swarm__wiki_search` used to call `GET /wiki/search` (keyword). That path is now
unused by the agent — the tool points at `/wiki/semantic-search` instead — but the
route still exists and is still broken/slow, and it is the only way to do an
_exact_ lookup (e.g. find a page by a literal id or token).

## The defect

`searchPages()` in `drone-swarm-common/src/wiki-storage.ts`:

- lowercases the query and does `title.includes(q)` / `tags.some(includes)` /
  `content.includes(q)` — a literal substring test of the **whole query string**;
- calls `listPages()` then `await readPage()` **per page**, every call, no index,
  no cache.

Measured against a 2,235-page corpus on the dev beacon:

| query                                                         | result   | time  |
| ------------------------------------------------------------- | -------- | ----- |
| `embedding`                                                   | 3 hits   | 21.1s |
| `what are the two embedding-related bugs found on 2026-10-13` | 0 (`[]`) | 29.4s |
| `zzqqxxnosuchtoken` (rare)                                    | 0        | 23.5s |
| `the` (common)                                                | 2.9 MB   | 22.6s |

So a miss costs as much as a hit (~23s) — it is a full-corpus scan, and the cost is
independent of whether anything matches.

## Why it can't match a question

The whole query string must appear verbatim as a substring. Natural language
therefore _always_ returns zero, which is exactly the phrasing the tool
description used to encourage.

## Candidate fixes (not chosen)

1. **Tokenised AND search** — split the query on whitespace/punctuation, require
   all (or N-of-M) terms, score by coverage. Turns "embedding bugs 2026-10-13"
   into a useful query without a vector index.
2. **Cache the corpus** — the per-call `listPages()`+`readPage()` fan-out is the
   real cost. An in-memory (or SQLite FTS5) keyword index rebuilt on write, or
   even a short-TTL snapshot, would drop ~23s to milliseconds.
3. **SQLite FTS5** — the beacon already has SQLite; an FTS5 virtual table over
   page title/tags/body would give tokenised search, ranking, and snippets for
   free, with triggers or hook-based maintenance alongside the existing write path.
4. **Expose as `mode` on the semantic tool** — one tool, `mode: 'semantic' |
'keyword'`, so the model can pick exact-token search when it knows the wording.

FTS5 (option 3) looks like the best cost/benefit: no new dependency, no
full-corpus scan, and it fixes ranking + snippets in the same move. Revisit when
someone actually needs exact-token wiki lookup.

## Do not

Do not simply speed up the substring scan while keeping whole-query matching — the
matching semantics are the primary defect; the 23s scan is secondary.
