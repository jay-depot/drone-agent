---
key: plan-search-path-exclude-filtering
tags:
  []
created: 2026-08-14T03:01:48.649Z
updated: 2026-08-14T03:01:48.649Z
---

# Plan: Honor search-path `exclude` globs (query-time filtering)

## Summary

`DroneSearchPath.exclude` is declared in config types/schema and sent to the beacon, but dropped at the `PUT /agents/:id/search-paths` route — the flags are never read, and `collectFiles` does no glob matching. The fix applies excludes **at query time** (in `GET /agents/:id/search`, right before cosine similarity) rather than at index time.

This approach:
- Dissolves the dedup conflict (the shared per-directory index serves each agent's own excludes on every query — no schema change, no persistence, no reindex/sweep concerns).
- Avoids all persistence/reindex/periodic-sweep failure modes (the sweep keeps indexing everything; excludes are applied fresh per query).
- Keeps `.git` and `node_modules` as **unconditional index-time skips** (node_modules never worth indexing; `.git` for the same reason). `includeHidden`/`includeNodeModules` remain dead flags, explicitly documented as **intended future functionality**.

## Design decisions

1. **`exclude` → query-time filter.** Agent passes its configured `exclude` patterns up with each semantic query (repeated `exclude` query params). Beacon filters chunks whose file path matches any glob **before** cosine similarity. No persistence.
2. **Glob semantics:** each pattern matched via `minimatch` against the file path **relative to the search-directory root** that owns the chunk (`path.relative(chunk.directory_path, chunk.file_path)`). Root-relative globs (e.g. `["**/dist/**", "*.log"]`).
3. **`.git` + `node_modules` always skipped at index time** (explicit, unconditional). `.git` is already skipped today via the generic dotfile check; make it an explicit ALWAYS_SKIP_DIRS entry with node_modules.
4. **`includeHidden` / `includeNodeModules` marked intended-future** in types/docs — remain dead flags.
5. **`minimatch`** must be added as a direct dep of `drone-beacon` (currently only transitive).

## Key facts (verified)

- `DroneSearchPath` types: `drone-core/src/config-types.ts:3-11`; schema: `config-schema.ts:205-211`.
- Agent sends full paths array to beacon: `drone-agent/src/plugins/search/index.ts:129` (PUT /agents/:id/search-paths).
- Beacon route drops flags, only `path.resolve(sp.path)` + `db.registerSearchPath(id, absDir)`: `routes/search.ts:53`.
- `collectFiles` hard-codes hidden/node_modules/binary skips, no glob exclude: `search-indexer.ts:202-266`.
- `indexDirectory` has 3 call sites: PUT route (routes/search.ts:59), reindex (routes/search.ts:208), periodic sweep runSweep (search-indexer.ts:185). Persistence would be REQUIRED if we filtered at index time — hence query-time approach.
- `search_directories` table: PK(agent_id, directory_path) + registered_at, no flags column (`db/init.ts:144-148`).
- Search chunks carry `directory_path` + `file_path` (SearchChunkRow), so query-time relative matching works for both scoped and unscoped queries.
- Tests: agent plugin tests in `drone-agent/test/search.test.ts`; beacon routes via `buildTestApp` (app-helper.ts) + `setupDb`/`teardownDb` in `routes.test.ts`; DB CRUD in `db.test.ts`. **No search-indexer test exists; no search DB tests exist.** SearchIndexer is instantiated in `drone-beacon/src/index.ts:186-191` and wired via `setSearchIndexer` (context.ts).

---

## Step 1 — Add `minimatch` to drone-beacon
**File:** `drone-beacon/package.json` — add `"minimatch": "^10.2.5"` to dependencies; run `pnpm install`.

## Step 2 — Refactor `collectFiles` for explicit `.git`/`node_modules` skips
**File:** `drone-beacon/src/search-indexer.ts`
- Introduce `const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);`
- In the directory branch, skip if `ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')`.
- **Export `collectFiles`** (change `async function collectFiles` → `export async function collectFiles`) so it can be unit-tested directly.
- Behavior identical today (`.git` already skipped via dotfile check).

## Step 3 — Query-time exclude filtering in the search route
**File:** `drone-beacon/src/routes/search.ts`
- `import { minimatch } from 'minimatch';`
- Extend GET Querystring type with `exclude?: string | string[]`.
- Normalize: `const exclude = Array.isArray(q.exclude) ? q.exclude : q.exclude ? [q.exclude] : [];`
- Add helper:
  ```ts
  function isExcluded(filePath: string, rootDir: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    const rel = path.relative(rootDir, filePath);
    return patterns.some(p => minimatch(rel, p));
  }
  ```
- In chunk loop (before cosine similarity, ~line 136): `const rootDir = directoryPath ?? chunk.directory_path; if (isExcluded(chunk.file_path, rootDir, exclude)) continue;`

## Step 4 — Agent passes `exclude` up with each semantic query
**File:** `drone-agent/src/plugins/search/index.ts` (`handleSemanticSearch`)
- Resolve configured excludes from `registration.getConfig().search.paths`, append as repeated `params.append('exclude', e)`.
- Behavior: when a `path` is given, send only excludes for matching registered roots; when unscoped, send all configured excludes (matched relative to each chunk's own root).
- NOTE: OPEN QUESTION (see below) — unscoped-query scoping semantics.

## Step 5 — Document `includeHidden`/`includeNodeModules` as intended-future; document `exclude` semantics
**File:** `drone-core/src/config-types.ts` (lines 3-11) — jsdoc on DroneSearchPath fields.
**File:** `drone-core/src/config-schema.ts` (lines 206-210) — add `description` strings for parity.

## Step 6 — Tests
**6a. New `drone-beacon/test/search-indexer.test.ts`** — `collectFiles` skip behavior: temp tree with `.git/`, `node_modules/`, `.hidden-dir/`, `src/a.ts`, `src/data.bin`. Assert `src/a.ts` present; `.git`, `node_modules`, hidden dir contents, binary absent.

**6b. `drone-beacon/test/routes.test.ts`** — search route exclude filtering:
- `setSearchIndexer(new SearchIndexer(mockProvider))` (mock provider returns fixed Float32Array); reset in afterEach.
- Register agent, `db.registerSearchPath('agent-1', '/proj')`, seed chunks under `/proj` with distinct embeddings.
- `GET /agents/agent-1/search?q=...&exclude=...` → excluded file's chunk absent; present without exclude param.

**6c. `drone-agent/test/search.test.ts`** — agent passes exclude params: mock swarm capability (`getBeaconUrl`, `getAgentId`), `getConfig` returns `search.paths=[{path:'/proj',exclude:['*.log']}]`, `vi.stubGlobal('fetch', ...)` capture URL; assert URL contains `exclude=*.log`.

## Step 7 — Validation
1. LSP diagnostics clean for all touched files (note pre-existing branch diagnostics: `drone-agent/test/search.test.ts` `Cannot find module 'drone-swarm-common'`, `prompt-file.test.ts` config-type error — do not introduce NEW diagnostics).
2. `pnpm -r run build` passes.
3. `pnpm -r run typecheck` passes.
4. `pnpm -r run lint` passes.
5. `pnpm -r run test` passes.
6. Manual smoke: `exclude: ["**/dist/**"]` honored across reindex + periodic sweep.

**Validation criteria:** all six checks green, no new LSP errors in touched files.

---

## OPEN QUESTION (resolve before/at execution)
Step 4 unscoped-query behavior: when query has no `path`, agent sends ALL configured excludes and beacon matches each glob relative to each chunk's own root. So `["**/dist/**"]` from path A also excludes `**/dist/**` under path B. If strict per-directory scoping is desired even for unscoped queries, would need a structured param (e.g. `excludesByDir`), which the current plan does NOT do. Default chosen: send all excludes, match per-chunk-root.
