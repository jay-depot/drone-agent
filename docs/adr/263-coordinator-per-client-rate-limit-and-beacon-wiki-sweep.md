# 263. Coordinator per-client rate limit and beacon wiki sweep

- Status: Accepted
- Date: 2026-10-25

## Context

Two recurring problems shared one cause: a periodically repeating request burst
that was never made cheap.

**The coordinator rate-limited every caller together.** `@fastify/rate-limit`
was registered with `max` + `timeWindow` and no key function, so it used its
default `req.ip` key: **one global bucket of 100 requests per 1000 ms**. Beacons
behind one NAT, a reverse proxy, or the loopback web port all shared that
bucket. The beacon's wiki sweep then became the dominant load: **around 20% of
active time exceeded the limit**, and **every sampled 429 was on
`/api/wiki/*`**.

**The beacon re-indexed the entire corpus every five minutes.**
`WikiIndexer` fetched the page list, then downloaded every page body and
re-embedded it. On a ~2,419-page corpus that is a **~2,420-request sweep every
5 minutes** (1 listing + 2,419 body `GET`s). The skip check ran _after_ the
body was fetched, so a skip saved only the embedding, not the request. A bare
`setInterval` let passes overlap, and an overrunning pass stacked on the next
tick — amplifying the load about **3×**. Each local wiki write fired its own
full sweep, so a burst of writes produced a burst of sweeps.

The two problems multiplied: the full sweep is what hit the shared bucket.

| Location                                             | Fact                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `drone-coordinator/src/index.ts:78-79`               | Default limit `100` / window `1000` ms — a single global bucket.                                      |
| `drone-coordinator/src/index.ts:379-382`             | Limiter registered with only `max` + `timeWindow`; no `keyGenerator`, so it keys on `req.ip`.         |
| `drone-coordinator/src/index.ts:637-638`, `:645-646` | Both the primary (mTLS) server and the web-port server get the same global limit.                     |
| `drone-coordinator/src/mtls.ts:47-62`                | `resolveRequestNodeId` — resolves a caller to a beacon node id (cert fingerprint, else header/query). |
| `drone-beacon/src/wiki-index-support.ts:29`          | `collectWikiPages` — one `GET /wiki` listing, then one page input per page.                           |
| `drone-beacon/src/wiki-indexer.ts:66-69`             | The indexer fetches each page body (`proxyWikiToCoordinator('GET', '/wiki/:pageId')`) to index it.    |
| `drone-beacon/src/wiki-indexer.ts:158-172`           | The skip check runs _after_ the fetch — a skip still costs a `GET`.                                   |
| `drone-beacon/src/wiki-indexer.ts:265-275`           | `startPeriodicSweep` — a bare `setInterval`; an overrun stacks on the next tick.                      |
| `drone-beacon/src/wiki-index-support.ts:88-94`       | `triggerWikiReindex` runs a full cycle per write.                                                     |
| `drone-beacon/src/routes/wiki.ts:157,187,197,220`    | Every wiki write/delete path calls `triggerWikiReindex`.                                              |
| (no location)                                        | No `ETag` / `If-None-Match` anywhere in beacon, coordinator, or swarm-common.                         |
| `drone-beacon/src/wiki-indexer.ts:30-42`             | The content hash folded the page **body** in with the embedding fingerprint.                          |
| `drone-beacon/src/search-indexer.ts:21,52,75,149`    | `SearchIndexer` already holds an in-flight guard (`indexing` set) — the model to copy.                |

## Decision

**D1. Key: rate-limit key = `resolveRequestNodeId(req) ?? req.ip`.** One bucket
per beacon node id; one per IP for web-port clients. No hook reordering.

**D2. Default: 1000 requests / 1000 ms, per client.** Constants and the existing
`--rate-limit-max` / `--rate-limit-window-ms` flags stay. No new config keys. No
per-route limits.

**D3. Skip before fetch: hash = `sha256(embedding-fingerprint, pageId, origin,
updatedAt)`; the body is removed from the hash; tested from listing metadata
BEFORE any body download; a valid skip makes no `GET /wiki/:pageId`.**

**D4. Change detection is `updatedAt`-based; every write path sets `updatedAt =
now`; a disk edit without a frontmatter change is out of contract.**

**D5. One-time reindex: because the hash scheme changes, the first sweep after
deploy is full; later sweeps are cheap.**

**D6. In-flight guard on the wiki sweep, copied from `SearchIndexer`.**

**D7. Pacing between coordinator page fetches.**

**D8. Debounced write reindex (local writes in a window cause one sweep, not
N).**

**D9. New `wikiIndex` config block: `sweepIntervalMs` 300000, `pacingMs` 50,
`writeReindexDebounceMs` 5000.**

**Steady state:** after the first full re-index, one sweep makes one request (the
listing) when no page changed.

## Out of scope

- Per-route rate limits.
- ETag / 304 (a 304 still counts against the limit).
- The coordinator's `listPages()` reading every body for one listing (follow-up
  note only).
- Retry/backoff for a failed page fetch.
- The hardcoded 5-minute interval in `search-indexer.ts`.

## Follow-up

The coordinator's `listPages()` reads every page body to build one listing
(`drone-swarm-common/src/wiki-storage.ts` ~:296) — a future metadata-only
listing should remove that cost.
