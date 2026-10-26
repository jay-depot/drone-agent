---
key: plan-coordinator-per-client-rate-limit-and-beacon-wiki-sweep
tags:
  - plan
  - coordinator
  - beacon
  - rate-limit
  - wiki
  - performance
created: 2026-10-26T01:57:06.573Z
updated: 2026-10-26T01:57:06.573Z
---

# Plan: Per-Client Coordinator Rate Limit + Beacon Wiki Sweep Fix

**Status:** completed
**Branch:** `fix/wiki-rate-limit-problems`
**Packages touched:** `drone-coordinator`, `drone-beacon`. No change to `drone-core` or `drone-swarm-common` source.
**ADR:** `docs/adr/262-coordinator-per-client-rate-limit-and-beacon-wiki-sweep.md`

## 1. Why we do this work

The coordinator limits all clients together. One shared bucket holds every client and every route. A beacon repeats a full wiki sweep every 5 minutes. The sweep makes about 2,420 HTTP requests against a corpus of about 2,419 pages. So the sweep causes about 20% of the active time to stay above the limit. The coordinator answers 429 to about 1,000 requests. All 429 answers are on `/api/wiki/*`.

Three fixes:

1. Make the rate limit per-client.
2. Stop the beacon from fetching unchanged pages, and pace the fetches that remain.
3. Set a higher default limit.

## 2. Evidence found in the code

| Fact                                                                                                            | Location                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Default limit is 100 requests per 1000 ms                                                                       | `drone-coordinator/src/index.ts:78-79`                                                            |
| `@fastify/rate-limit` is registered with `max` and `timeWindow` only. Default key = `req.ip`. Bucket is global. | `drone-coordinator/src/index.ts:379-382`                                                          |
| Both ports get the same limit                                                                                   | `drone-coordinator/src/index.ts:637-638`, `:645-646`                                              |
| Middleware order in `buildApp()`: CORS, rate-limit, web-auth, mTLS, WebSocket, routes                           | `drone-coordinator/src/index.ts:371-405`                                                          |
| `resolveRequestNodeId()`: client cert → beaconId, else `x-node-id` header, else `?beaconId=` query              | `drone-coordinator/src/mtls.ts:47-62`                                                             |
| Wiki sweep = 1 listing GET + N page GETs                                                                        | `drone-beacon/src/wiki-index-support.ts:29`, `drone-beacon/src/wiki-indexer.ts:66-69`             |
| Skip test runs AFTER download, so it can never prevent a fetch                                                  | `drone-beacon/src/wiki-indexer.ts:158-172`                                                        |
| Periodic sweep = bare `setInterval`, no in-flight guard → overlapping passes (~3× amplification)                | `drone-beacon/src/wiki-indexer.ts:265-275`                                                        |
| `triggerWikiReindex()` runs a FULL sweep on every local wiki write                                              | `drone-beacon/src/wiki-index-support.ts:88-94`, `drone-beacon/src/routes/wiki.ts:157,187,197,220` |
| No ETag / `If-None-Match` / `If-Modified-Since`                                                                 | `drone-swarm-common/src/coordinator-fetch.ts`, `drone-coordinator/src/routes/wiki.ts`             |
| Hash folds in body + embedding fingerprint                                                                      | `drone-beacon/src/wiki-indexer.ts:30-42`                                                          |
| `SearchIndexer` has the model in-flight guard to copy                                                           | `drone-beacon/src/search-indexer.ts:21,52,75,149`                                                 |

## 3. Decisions (all confirmed with the user)

- **D1 — Key.** Rate-limit key = `resolveRequestNodeId(req) ?? req.ip`. One bucket per beacon node id; one bucket per IP for web-port clients. No hook reordering needed.
- **D2 — Default.** New default = **1000 requests / 1000 ms, per client**. Constants + existing `--rate-limit-max` / `--rate-limit-window-ms` flags stay. No new config keys. No per-route limits.
- **D3 — Skip before fetch.** Change hash = `sha256(embedding-fingerprint, pageId, origin, updatedAt)`. Body removed from the hash. Beacon tests the hash from listing metadata BEFORE downloading the body. A valid skip makes no `GET /wiki/:pageId`.
- **D4 — Change detection is `updatedAt`-based.** Every write path sets `updatedAt = now`. A disk edit without a frontmatter change is out of contract.
- **D5 — One-time reindex.** Hash scheme changes, so the first sweep after deploy is full. Later sweeps are cheap.
- **D6 — In-flight guard.** Wiki sweep gets a guard, copied from `SearchIndexer`.
- **D7 — Pacing.** Beacon waits between coordinator page fetches.
- **D8 — Debounced write reindex.** Local writes within a time window cause one sweep, not N.
- **D9 — New config block.** `wikiIndex` in `ServerConfigFile`: `sweepIntervalMs` (default 300000), `pacingMs` (default 50), `writeReindexDebounceMs` (default 5000).

## 4. Out of scope

- Per-route rate limits.
- ETag / 304 responses (a 304 still counts against the limit).
- Coordinator `listPages()` reads every body for one listing — follow-up note only.
- Retry/backoff for a failed page fetch.
- The hardcoded 5-minute interval in `search-indexer.ts`.

## 5. Execution steps

| #   | Step                                           | Agent    | Depends on |
| --- | ---------------------------------------------- | -------- | ---------- |
| 1   | Add the shared rate-limit key module           | coder    | —          |
| 2   | Register the key generator and new defaults    | coder    | 1          |
| 3   | Update the coordinator rate-limit tests        | tester   | 2          |
| 4   | Add the `wikiIndex` server-config block        | coder    | —          |
| 5   | Skip before fetch in the wiki indexer          | coder    | 4          |
| 6   | Add the in-flight guard                        | coder    | 5          |
| 7   | Add the debounced write reindex                | coder    | 6          |
| 8   | Add fetch pacing                               | coder    | 5          |
| 9   | Wire the beacon config through startup         | coder    | 4,7,8      |
| 10  | Update and add beacon tests                    | tester   | 5-9        |
| 11  | Update docs and write ADR 262                  | coder    | 1-10       |
| 12  | Check the work against the validation criteria | reviewer | 1-11       |

### Step 1 — Add the shared rate-limit key module

Create `drone-coordinator/src/rate-limit.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import { resolveRequestNodeId } from './mtls.js';

/** Default per-client request limit. */
export const DEFAULT_RATE_LIMIT_MAX = 1000;
/** Default window length in milliseconds. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Rate-limit key: the resolved node id when we know the caller, else the IP.
 * One bucket per beacon; one bucket per IP for web-port clients.
 */
export function resolveRateLimitKey(req: FastifyRequest): string {
  return resolveRequestNodeId(req) ?? req.ip;
}
```

Remove `DEFAULT_RATE_LIMIT_MAX` and `DEFAULT_RATE_LIMIT_WINDOW_MS` from `drone-coordinator/src/index.ts:78-79`. Import them from `./rate-limit.js`.

### Step 2 — Register the key generator and new defaults

In `drone-coordinator/src/index.ts`, `buildApp()` at line 379:

```ts
await app.register(import('@fastify/rate-limit'), {
  max: opts?.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
  timeWindow: opts?.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  keyGenerator: resolveRateLimitKey,
});
```

Confirm the two `buildApp()` calls at `index.ts:637-638` and `:645-646` still pass `config.rateLimitMax` and `config.rateLimitWindowMs`. Do not change the flags at `index.ts:161-164`.

### Step 3 — Update the coordinator rate-limit tests

In `drone-coordinator/test/app-helper.ts`, add `keyGenerator: resolveRateLimitKey` to the plugin registration at line 24.

In `drone-coordinator/test/rate-limit.test.ts`, keep the two existing tests. Add:

- **Per-IP independence.** Send `max` requests with `remoteAddress: '10.0.0.1'`. Then one request with `remoteAddress: '10.0.0.2'`. Assert 200, not 429.
- **Node-id keying.** Insert an approved beacon trust row for a test beacon (helpers in `test/setup.ts`). Send `max` requests with header `x-node-id: <test-beacon>` from address A. Send the next request with the same header from address B. Assert 429 — both share one bucket keyed by the node id.

### Step 4 — Add the `wikiIndex` server-config block

In `drone-swarm-common/src/config-file.ts`:

```ts
/**
 * Beacon-global wiki index schedule. Controls how often the merged wiki is
 * re-indexed, how much the sweep paces its fetches, and how write bursts
 * coalesce into one re-index.
 */
export interface WikiIndexConfig {
  sweepIntervalMs: number;
  pacingMs: number;
  writeReindexDebounceMs: number;
}

export function defaultWikiIndexConfig(): WikiIndexConfig {
  return {
    sweepIntervalMs: 5 * 60 * 1000,
    pacingMs: 50,
    writeReindexDebounceMs: 5000,
  };
}
```

Add `wikiIndex?: WikiIndexConfig;` to `ServerConfigFile`. Add `'wikiIndex'` to `ALLOWED_KEYS`. Add `validateWikiIndex()` (same shape as `validateRanking()`), called from `validateConfigFile()` when the key is present. Reject unknown keys and non-finite numbers.

### Step 5 — Skip before fetch in the wiki indexer

In `drone-beacon/src/wiki-indexer.ts`:

1. Change `pageHash()` at line 30 to drop the `content` term:

```ts
function pageHash(
  pageId: string,
  origin: string,
  updatedAt: string,
  fingerprint: string
): string {
  return createHash('sha256')
    .update(fingerprint)
    .update('\u0000')
    .update(`${pageId}\u0000${origin}\u0000${updatedAt}`)
    .digest('hex');
}
```

2. Reorder the loop body in `indexWiki()` at lines 158-172. Compute the hash from `entry.page.updatedAt` FIRST. Look up `stored`. If `stored && stored.hash === hash && stored.chunk_count > 0`, run the existing FTS-repair branch and `continue`. Do NOT call `fetchPageContent()` in this path. Only when the skip test fails, call `fetchPageContent(entry)` and continue with the existing chunk + embed path.

A beacon-origin page also stops costing a file read when it is unchanged.

### Step 6 — Add the in-flight guard

In `drone-beacon/src/wiki-indexer.ts`, add to `WikiIndexer`:

```ts
private cycleRunning = false;

/**
 * Run one index cycle. A second call while a cycle runs is a no-op, so
 * periodic ticks and write bursts cannot overlap into extra sweeps.
 */
async runCycle<T>(fn: () => Promise<T>): Promise<T | null> {
  if (this.cycleRunning) {
    logger.info('Wiki index: cycle already running, skipping');
    return null;
  }
  this.cycleRunning = true;
  try {
    return await fn();
  } finally {
    this.cycleRunning = false;
  }
}
```

In `drone-beacon/src/wiki-index-support.ts`, change `runWikiIndexCycle()` to run its body inside `indexer.runCycle(...)`. The function already returns `Promise<WikiIndexResult | null>`, so a skipped cycle returns `null`.

`POST /wiki/reindex` at `drone-beacon/src/routes/wiki.ts:225-233` must report the skipped case:

```ts
const result = await runWikiIndexCycle(indexer);
if (!result) {
  return {
    success: true,
    skipped: true,
    note: 'index cycle already in progress',
  };
}
return { success: true, result };
```

### Step 7 — Add the debounced write reindex

In `drone-beacon/src/wiki-index-support.ts`, replace the body of `triggerWikiReindex()`:

```ts
let reindexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeReindexDebounceMs = 5000;

export function setWikiReindexDebounceMs(ms: number): void {
  writeReindexDebounceMs = ms;
}

/**
 * Coalesce a burst of local wiki writes into one index cycle. Repeated calls
 * inside the window reset the timer, so N writes cause one sweep.
 */
export function triggerWikiReindex(): void {
  if (reindexDebounceTimer) clearTimeout(reindexDebounceTimer);
  reindexDebounceTimer = setTimeout(() => {
    reindexDebounceTimer = null;
    const indexer = getWikiIndexer();
    if (!indexer) return;
    runWikiIndexCycle(indexer).catch(err => {
      logger.warn(`Wiki index: post-write reindex failed: ${err}`);
    });
  }, writeReindexDebounceMs);
}
```

### Step 8 — Add fetch pacing

In `drone-beacon/src/wiki-indexer.ts`:

1. Add a `pacingMs` field and a fourth constructor parameter:

```ts
constructor(
  provider?: DroneEmbeddingProvider,
  sweepIntervalMs: number = 5 * 60 * 1000,
  fingerprint: string = '',
  pacingMs: number = 50
) {
```

2. In the `indexWiki()` loop, when the entry is a coordinator page with no inline content, wait `pacingMs` before `fetchPageContent()`:

```ts
if (
  entry.content === undefined &&
  entry.origin === 'coordinator' &&
  this.pacingMs > 0
) {
  await sleep(this.pacingMs);
}
const content = await fetchPageContent(entry);
```

A full 2,400-page reindex then takes about 2 minutes, and it does not burst.

### Step 9 — Wire the beacon config through startup

In `drone-beacon/src/index.ts`:

1. Add `wikiIndex?: WikiIndexConfig;` to the `Config` interface (near line 112).
2. Set the default in `parseArgs()`: `wikiIndex: defaultWikiIndexConfig()`.
3. After `mergeConfig` at line 228, apply `merged.wikiIndex` when present.
4. Change the `WikiIndexer` construction at lines 338-342:

```ts
const wiki = config.wikiIndex ?? defaultWikiIndexConfig();
const wikiIndexer = new WikiIndexer(
  embedding.provider,
  wiki.sweepIntervalMs,
  embedding.fingerprint,
  wiki.pacingMs
);
setWikiIndexer(wikiIndexer);
setWikiReindexDebounceMs(wiki.writeReindexDebounceMs);
wikiIndexer.startPeriodicSweep(() => runWikiIndexCycle(wikiIndexer));
```

5. Add `wikiIndex` to the `--help` text.

### Step 10 — Update and add beacon tests

In `drone-beacon/test/wiki-indexer.test.ts`:

- **Update any test that relies on a body change to trigger a re-index.** The trigger is now an `updatedAt` change.
- **Add a skip-before-fetch test.** Index one coordinator-origin page. Run a second cycle with the same `updatedAt`. Assert `proxyWikiToCoordinator` was NOT called for that page (spy or fetch stub). Run a third cycle with a new `updatedAt`. Assert the fetch DID occur.
- **Add an in-flight-guard test.** Start one cycle against a slow provider. Call a second cycle before the first completes. Assert the second returns `null` and makes no extra fetch.

In `drone-beacon/test/wiki-index-support.test.ts`:

- **Add a debounce test.** Use `vi.useFakeTimers()`. Call `triggerWikiReindex()` three times. Advance the timer. Assert `runWikiIndexCycle` ran once.

### Step 11 — Update docs and write ADR 262

1. `drone-coordinator/README.md` lines 47-48: default `1000` for both flags. Add one line: "The limit is per client. The client is the resolved node id, or the IP address when the node is unknown."
2. `drone-beacon/README.md`: add the `wikiIndex` config block.
3. Create `docs/adr/262-coordinator-per-client-rate-limit-and-beacon-wiki-sweep.md` with D1-D9, the evidence table, and the follow-up about the coordinator `listPages()` read cost.
4. Add the row for ADR 262 to `docs/adr/index.md`.

### Step 12 — Check the work against the validation criteria

Run the full validation section below. Do not mark the work complete until every item passes.

## 6. Validation criteria

1. **LSP.** All diagnostics clean for every touched `.ts` file in `drone-coordinator` and `drone-beacon`. Pre-existing `drone-agent/test/*` errors about `DroneToolUnmountResult` are NOT from this work — do not break them further, do not fix them here.
2. **Build.** `pnpm -r run build` passes with zero errors.
3. **Lint.** `pnpm run lint` passes with zero errors. Prettier reformats when eslint succeeds — re-read every touched file after lint before any further edit.
4. **Tests.** `pnpm run test` passes, including the new tests (steps 3, 10) and updated `test/wiki-indexer.test.ts`.
5. **Per-client behaviour.** A test proves two clients do NOT share one bucket, and one node id DOES share one bucket across two addresses.
6. **Skip behaviour.** A test proves an unchanged coordinator page causes no page fetch, and a changed page does cause a fetch.
7. **No overlap.** A test proves a second cycle during a running cycle is skipped.
8. **Debounce.** A test proves a burst of write triggers causes one cycle.
9. **Steady state.** After the first full re-index, one sweep makes one request (the listing) when no page changed. State this result in the ADR.
10. **Docs.** Both READMEs and ADR 262 updated; ADR index has the new row.
11. **Memories committed.** Project memory and any insights committed on the `fix/wiki-rate-limit-problems` branch with the code.
