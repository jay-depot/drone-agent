# 260. Keyword wiki index and beacon-side fusion

- Status: Accepted
- Date: 2026-10-21

## Context

`GET /wiki/search` was a literal whole-query substring scan: `searchPages()` in
`drone-swarm-common/src/wiki-storage.ts` lowercased the query and tested
`title.includes(q)` / `tags.some(includes)` / `content.includes(q)` against the
**entire query string**, calling `listPages()` then `readPage()` **per page** on
every call, with no index. Measured on the 2,235-page corpus of a dev beacon:

| query                                                         | hits | time                     |
| ------------------------------------------------------------- | ---- | ------------------------ |
| `embedding` (literal token)                                   | 3    | 21.1 s                   |
| `what are the two embedding-related bugs found on 2026-10-13` | 0    | 29.4 s                   |
| `zzqqxxnosuchtoken` (rare literal)                            | 0    | 23.5 s                   |
| `the` (matches nearly everything)                             | many | 22.6 s (2.9 MB response) |

A miss cost as much as a hit, which is the tell that this is a corpus scan and
not a lookup. Because the whole query string had to appear verbatim, a
natural-language question _always_ returned nothing.

Separately, the swarm-memory RAG had no lexical stage at all. Retrieval was
dense-only: the agent fanned out one request per query input per source
(2N requests) and merged by per-document MAX score.

This ADR **supersedes ADR 245 D1** ("extend the existing dense-only RAG; no
lexical/BM25/FTS stage") and **ADR 245 D2** ("agent-side fan-out"). Both were
explicitly temporary: D1 was a scoping decision for that change, and D2 kept the
fusion logic next to the conversation window while the shape was still moving.
This change is the point at which the shape settled and both were due.

## Decision

**D1. Fusion is additive and saturating.** A page's score is
`cosine + keywordBoost * min(1, matchedTerms / 2)`. `keywordBoost` defaults to
`0.08`, matching the existing anchor-boost scale.

- **Not convex** (`a*cosine + b*coverage`): wiki and file entries compete in a
  single `sort().slice(topK)`, so scaling only the wiki side multiplies every
  wiki score by `a` while file scores stay raw cosine. That is a systematic tax
  on one kind for reasons unrelated to relevance. Adding a bounded bonus leaves
  an entry with no keyword match at exactly its cosine.
- **Not RRF**: reciprocal-rank fusion discards score magnitude, so it cannot
  express an absolute quality floor. Its score range (max `1/61 ≈ 0.0164` per
  list) also silently breaks a `minScore` of 0.35 — every result would be
  filtered — and would make the 0.08 anchor boosts over twice the entire
  relevance range.

**D2. Saturation at two matched terms, not a fraction of the query length.**
Dividing by the query's content-term count makes a single solid match on a long
query nearly worthless. Measured: at `keywordBoost = 0.08`, linear coverage with
one match out of five yields `+0.016` (roughly a tenth of the observed cosine
spread), while saturating coverage yields `+0.04`.

**D3. Coverage is scored against the current user query only.** Query assembly
emits up to three inputs (the current query plus window text segmented at up to
6,000 tokens). Scoring coverage against the window would make the denominator
enormous and drive coverage to ~0 for every page, silently disabling the feature.

**D4. Stopwords are stripped before the denominator**, so coverage is
`matched / content_terms`. Negations (`not`, `no`, `never`) are deliberately
**not** stopwords — they carry meaning in a debugging query.

**D5. Two FTS5 tables, because a tokenizer is a table option.** FTS5 cannot mix
tokenizers per column, so the two uses cannot share a table:

- `wiki_fts` with `tokenize='porter'` — stemming. Feeds coverage scoring, so
  `reindex` matches `reindexing`.
- `wiki_fts_trigram` with `tokenize='trigram'` — substring matching. Feeds
  explicit navigational lookup, where stemming would be lossy: commit hashes
  (`5e313af9`), page ids, `ADR 259`, `nomic-embed-text:v1.5`.

**Explicit keyword search is therefore trigram, not stemmed.** The two indexes
have different consumers: porter answers "does this page discuss the concept?",
trigram answers "show me the page whose id contains `reindex-duplicate`".

**D6. `page_id` is indexed on the trigram table only.** The plan had it
`UNINDEXED` on both, but finding a page _by its id_ is the stated purpose of the
keyword route. The stemmed table keeps it `UNINDEXED` so ids do not pollute
coverage scoring.

**D7. `minScore` is applied after fusion**, so keyword evidence can lift a page
whose cosine alone falls short. The filter previously ran per-source before any
merge, which would delete a below-floor page before fusion could see it. The
default stays `0.35`; measured wiki results all scored ≥ 0.638, so the floor is
nearly inert for wiki and keeping it does not tighten anything.

**D8. Ranking is beacon-global.** `topK`, `minScore`, `keywordBoost` and
`anchors` move to the beacon's `ranking` config block, mirroring `embedding`.
Ranking is a property of the corpus, not of the asking agent. The agent keeps
only conversation-shaped settings: `enabled` and `window.*`. Defaults match the
values the agent previously held, so the move does not silently reorder results.

**D9. Fusion and fan-out move into the beacon.** One `POST
/swarm-memory/retrieve` replaces the agent's 2N fan-out. The beacon fans out
internally (it already knows an agent's registered search paths via
`listSearchPaths`), fuses, and returns the final ranked list. The agent keeps
`buildQueryInputs`, the hash-debounced cache, fragment rendering, and the
`enabled`/`sessionEnabled` gates.

**D10. FTS maintenance rides the existing wiki index cycle**, not the write path.
There is one freshness story (a 5-minute sweep plus a post-write trigger) rather
than two.

## Consequences

- **Scores may exceed 1.0** (`cosine 1.0 + 0.08`). Only a sort and a
  `toFixed(2)` display consume them, but anything treating the value as a
  cosine similarity would be wrong.
- **FTS can lag up to one sweep interval** behind a wiki write.
- **The coordinator corpus is not indexed.** Coordinator pages are fetched and
  indexed by the beacon's vector index but do not appear in the keyword index,
  so keyword coverage only ever boosts beacon-origin pages. `GET /wiki/search`
  still merges coordinator results by proxying.
- **`swarm.memory.topK` / `minScore` / `anchors` are deprecated** agent keys.
  They warn once at register rather than being ignored silently. A config
  spanning two files is the accepted cost.
- The keyword route no longer reads every page; it reads only the matched pages,
  so a query costs an index lookup plus a handful of `readPage` calls.

## Not done (deferred)

- Coordinator-corpus indexing.
- BM25/IDF weighting in place of plain coverage. BM25 is unbounded and negative,
  so it would need squashing into `[0, 1]`; plain coverage was shipped first
  because it is bounded for free and easier to reason about.
- RRF as a configurable alternative fusion.
- Title/body field weighting, occurrence counting, and phrase boost — all three
  are worth adopting behind the flat saturating coverage once there is real data
  to tune against.
