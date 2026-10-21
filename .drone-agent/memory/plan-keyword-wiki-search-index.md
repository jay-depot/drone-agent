---
key: plan-keyword-wiki-search-index
tags:
  - plan
  - wiki
  - search
  - fts5
  - bm25
  - hybrid-retrieval
  - drone-beacon
  - drone-swarm-common
  - drone-agent
  - sqlite
  - adr-260
---

# Plan: Keyword (FTS5) Wiki Index + Beacon-Side Fusion

**Status**: ready for execution. Next ADR = **260** (supersedes ADR 245 D1/D2).

## 1. Summary

`GET /wiki/search` → `searchPages()` is a literal whole-query substring scan over every
page (`listPages()` + `readPage()` per call). It cannot match a natural-language question
and costs ~23 s on 2,235 pages, with a miss as expensive as a hit.

This plan adds a real keyword index and uses it **two ways**:

1. **Composite recall** — a stemmed (porter) FTS5 index scores pages by keyword coverage;
   that score is added to the semantic cosine as a bonus, so keyword evidence can lift a
   page the embedder ranked low.
2. **Explicit keyword search** — a trigram FTS5 index answers exact/navigational lookups
   (`5e313af9`, `ADR 259`, `nomic-embed-text:v1.5`) where stemming would destroy the token.

Fusion and workspace fan-out move from the agent into the beacon, so the agent makes **one**
request per refresh instead of 2N.

## 2. Locked decisions

| # | Decision |
| --- | --- |
| D1 | **Additive, saturating fusion**: `score = cos + 0.08 * min(1, matched / 2)`. Not convex, not RRF. |
| D2 | `b = 0.08` matches the existing bonus scale (`boostPerTag`). Saturation at 2 matches so one hit is worth half credit. |
| D3 | **Coverage is computed against the current user query only**, never the 6000-token window. |
| D4 | Stopwords stripped; denominator = **content** term count. |
| D5 | **Two FTS5 tables**: `wiki_fts` (`tokenize='porter'`) and `wiki_fts_trigram` (`tokenize='trigram'`). |
| D6 | **`minScore` stays 0.35** and the filter moves to **after** fusion. |
| D7 | Fusion + workspace fan-out move **into the beacon**; ranking config moves to **beacon config**. |
| D8 | Beacon-only for now; the coordinator corpus is out of scope. |
| D9 | FTS maintenance rides the **existing wiki index cycle**, not write-through. |

### Why not convex or RRF (recorded so it is not relitigated)

- **Convex** (`a·cos + b·cov`) scales only the wiki side, but wiki and file entries share a
  single `sort().slice(topK)` in `memory-retrieval.ts:354`. A 0.7 coefficient is a systematic
  tax on every wiki page against every file hit.
- **RRF** discards magnitude, so it cannot express an absolute quality floor, and its score
  range (max 0.0328 for N=2) silently breaks `minScore: 0.35` and the anchor boosts.

## 3. Data behind the constants

Measured on the local beacon (2,235 pages):

| observation | value |
| --- | --- |
| cosine, rank 1 → last returned | 0.801 → 0.638 (q1 spread **0.163**); q2 0.064; q3 0.085 |
| results in the 0.35–0.50 band | **0** |
| linear coverage at `b=0.08`, 1 of 5 terms | **+0.016** (too weak) |
| saturating coverage at `b=0.08`, 1 of 2+ terms | **+0.04** (meaningful) |

The 0.35 floor is nearly inert for wiki results (everything ≥ 0.638), which is why keeping it
is safe.

## 4. Schema (drone-beacon/src/db/init.ts)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  page_id UNINDEXED, origin UNINDEXED,
  title, tags, pitch, body,
  tokenize = 'porter'
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts_trigram USING fts5(
  page_id UNINDEXED, origin UNINDEXED,
  title, tags, body,
  tokenize = 'trigram'
);
```

Two tables because a tokenizer is a **table** option — tokenizers cannot be mixed per column.
Both index beacon-origin pages only (D8). `page_id` is `UNINDEXED` (a key, not searchable text);
the trigram table additionally matches substrings of `page_id` via the body/title text.

## 5. New module: `drone-swarm-common/src/wiki-fts.ts`

```ts
export type WikiFtsMode = 'stemmed' | 'trigram';
export type WikiFtsHit = { pageId: string; origin: string; score: number };

// db injected as a thunk per db-helpers.ts (this package has NO better-sqlite3 dep)
export function searchWikiFts(
  db: () => Database,
  query: string,
  opts: { mode: WikiFtsMode; limit?: number; origin?: string }
): WikiFtsHit[];

export function replaceWikiFtsRows(
  db: () => Database,
  page: { pageId: string; origin: string; title: string; tags: string;
          pitch?: string; body: string }
): void;

export function deleteWikiFtsRows(db: () => Database, pageId: string, origin: string): void;
```

Structural `Database`/`Statement` interfaces already exist in `db-helpers.ts` —
reuse them, do not add a native dependency.

## 6. New module: `drone-swarm-common/src/keyword-coverage.ts`

```ts
export function contentTerms(query: string): string[];   // lowercase, strip stopwords, len > 2
export function keywordCoverage(terms: string[], text: string): number;
// = min(1, matched / 2)   — D2 saturation
```

Stopword list lives here as a module constant. **`not` and negations stay off the list.**
`terms` are prepared once per query, then reused for every candidate page.

Note: the porter index already stemmed what it stored, so coverage matching should compare
against `searchWikiFts` hits rather than re-stemming text — see Phase C.

## 7. Beacon changes

### 7.1 FTS population — `wiki-indexer.ts`

Inside the existing per-page loop, after `db.replaceWikiPage(...)` succeeds (~line 179), call
`replaceWikiFtsRows(db, {...})` with the page's title/tags/pitch and the **joined chunk text**
as `body`. Deletions (the `pagesRemoved` branch and the reconcile path) call
`deleteWikiFtsRows`. This reuses the existing hash-skip and 5-min sweep — one freshness story.

Add a one-shot backfill on first run for existing pages (detect by counting FTS rows).

### 7.2 New route `POST /swarm-memory/retrieve`

Replaces the agent's 2N fan-out. Body:

```jsonc
{ "agentId": "agent-123", "inputs": ["<current query>", "<window segment>", "..."],
  "topK": 5 }
```

Steps:
1. Resolve the agent's search paths via `db.listSearchPaths(agentId)` (the beacon already does this).
2. For **each** input: cosine search over `wiki_vec_chunks` and over `vec_chunks` (per path).
3. For **input[0] only** (D3): FTS search over `wiki_fts`, compute coverage, and add
   `0.08 * coverage` to that page's score.
4. Per-document MAX across inputs and kinds, then apply anchor boosts, then **filter by
   `minScore`** (D6), then `sort` and `slice(topK)`.

Returns the same `SwarmMemoryEntry`-shaped payload the agent merges today.

### 7.3 `GET /wiki/search` becomes trigram-backed

Replace the `searchPages()` substring scan with `searchWikiFts(db, q, { mode: 'trigram' })`.
Response shape stays `{ page, snippet, score }` so existing callers do not break, but it gets
fast. Coordinator proxying stays as-is.

### 7.4 Beacon config (`drone-swarm-common/src/config-file.ts`)

Mirror the `embedding` block pattern (add to `ServerConfigFile`, `ALLOWED_KEYS`, and a
`validateRanking` that reuses `validateEmbeddingSubBlock`'s shape):

```jsonc
{ "ranking": {
    "topK": 5, "minScore": 0.35,
    "keywordBoost": 0.08,
    "anchors": { "tags": [], "boostPerTag": 0.08, "boostTitle": 0.05 } } }
```

## 8. Agent changes (`memory-retrieval.ts`)

- `retrieve()` collapses to a single `POST /swarm-memory/retrieve` per refresh.
- Delete local MAX-merge, `applyAnchorBoosts`, `minScore`/`topK` plumbing.
- **Keeps**: `buildQueryInputs` (window, token budget, segmentation — `memory.window.*`),
  hash-debounced caching, prompt-fragment rendering, `enabled`/
  `sessionEnabled` gating.
- `swarm.memory.topK`/`minScore`/`anchors` become **deprecated agent keys** that warn and are
  ignored (beacon owns them now). Keep `window.*` and `enabled`.

## 9. ADR 260

`docs/adr/260-keyword-wiki-index-and-beacon-fusion.md`:
- **Supersedes ADR 245 D1** ("no lexical/BM25/FTS stage") and **D2** ("agent-side fan-out").
  Record that D1/D2 were explicitly temporary.
- D1–D9 above, the rejection rationale for convex/RRF, the measured spreads, and the
  `minScore`-after-fusion rule.
- Consequences: hybrid scores may exceed 1.0 (clamp for display); FTS can lag up to one
  sweep interval; coordinator corpus remains unindexed.

## 10. Phases

**A — Index** (`drone-swarm-common`): `wiki-fts.ts`, `keyword-coverage.ts` + unit tests
(tokeniser availability, porter stemming hit, trigram substring hit, coverage saturation,
stopword stripping). No behaviour change yet.

**B — Schema + population** (`drone-beacon`): DDL in `init.ts`; `replaceWikiFtsRows` /
`deleteWikiFtsRows` wired into `wiki-indexer.ts`; backfill. Test: index a page, FTS finds it;
reindex does not duplicate rows; delete removes them.

**C — Retire the substring scan**: `GET /wiki/search` → trigram. Test: `5e313af9` and
`ADR 259` are findable; a natural-language question still returns something sane.

**D — Fusion + new route**: `POST /swarm-memory/retrieve` with additive saturating scoring and
`minScore` after fusion. Tests: keyword lifts a low-cosine page; `minScore` still filters;
file and wiki entries stay comparable (no convex-style tax).

**E — Agent simplification**: collapse `retrieve()`, deprecate the moved keys, keep `window.*`
and `enabled`. Test: one request per refresh; deprecated keys warn; cache hash unchanged.

**F — Docs**: ADR 260 + `docs/adr/index.md`; `docs/agents/` note on the beacon now owning
ranking; project wiki update.

## 11. Validation

LSP clean; `pnpm -r run build`; `tsc -p tsconfig.test.json`; `pnpm run lint`; `pnpm run test`.
Behavioural: with a live beacon, a query whose page is semantically mid-pack but has strong
keyword overlap must enter the top 5; a pure-semantic query must return the same top-5 as
before the change.

## 12. Open items (defaulted — flag if wrong)

- `window.{maxQueryTokens,maxQuerySegments}` stay **agent-side** (conversation state).
- `swarm.memory.enabled` stays **agent-side** (gates fragment + network); ranking moves beacon-side.
  → one feature's config spans two files; accepted.
- Clamp the display score at 1.0 in the prompt fragment (raw score may reach 1.08).

## 13. Deferred

Coordinator corpus indexing; BM25/IDF weighting in place of plain coverage; RRF as an
alternative fusion behind config; making the wiki reindex route asynchronous.

## 14. Noted but deferred (from the `brillio-interview-rag-keyword-retrieval` precedent)

A prior project on this host implemented the same lexical-retrieval idea
(`/home/unleet/Projects/brillio-interview/packages/backend/src/rag/keywordSearch.ts`,
verified from code 2026-10-21). Three of its scoring refinements are worth adopting but are
**explicitly deferred** — ship the flat saturating coverage first, then measure and revisit:

1. **Field weighting (title != body).** Their `TITLE_TERM_WEIGHT = 4` vs
   `CONTENT_TERM_WEIGHT = 1`. Wiki page ids/titles are highly descriptive
   (`drone-beacon-wiki-reindex-duplicate-chunks-on-hash-mismatch`), so title matches carry
   real signal we currently ignore. FTS5 supports this natively via `bm25(table, 4.0, 1.0)`
   column weights. Inside our envelope it would become:
   `coverage = min(1, (2*titleMatches + bodyMatches) / 2)` — keeps `b = 0.08` intact while a
   title hit alone earns full credit.
2. **Occurrence counting, not distinct terms.** They use
   `countOccurrences(stems, queryStem) * WEIGHT`. Frequency captures salience; our plan
   counts each matched term once. Cheap to adopt.
3. **Phrase boost.** Their `PHRASE_BOOST = 12` for quoted `"..."`/`'...'`. We get most of
   this free: route quoted input to the existing `wiki_fts_trigram` table rather than the
   porter one.

**Deliberately NOT adopted:** their Lancaster stemmer (FTS5 ships Porter; a second token
pipeline is not worth maintaining) and their product-name scoping
(`detectReferencedProductIds` — solves a multi-tenant problem we do not have).

**Constraint on (1):** any field weighting must stay inside the `0.08` boost envelope, since
we add to cosine rather than sorting by a raw integer sum the way they do.
