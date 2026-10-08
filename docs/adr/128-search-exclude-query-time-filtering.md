---
tags: [decision, search, semantic-search, config]
related:
  [
    modules/drone-beacon.md,
    modules/drone-agent-plugins.md,
    concepts/semantic-search.md,
    decisions/127-semantic-search-beacon.md,
  ]
---

# 128. Search-Path Exclude Globs — Query-Time Filtering

**Summary**: `DroneSearchPath.exclude` glob patterns are honored **at query time** (in `GET /agents/:id/search`, right before cosine similarity) rather than at index time. This dissolves the dedup conflict inherent to a shared per-directory index and avoids all persistence/reindex/periodic-sweep failure modes.

## Context

`DroneSearchPath.exclude` was declared in config types/schema and sent to the beacon, but dropped at the `PUT /agents/:id/search-paths` route — the flags were never read, and `collectFiles` did no glob matching.

The naive fix (filtering at index time) was rejected because the beacon uses a **single shared per-directory index**. Each agent registers directories that may overlap, and the same directory index serves every agent. Index-time filtering would require persisting per-agent excludes and reindexing/sweeping on config change — a maintenance nightmare and a source of inconsistent state.

## Decision

### 1. Exclude → query-time filter

The agent passes its configured `exclude` patterns up with each semantic query (repeated `exclude` query params). The beacon filters chunks whose file path matches any glob **before** cosine similarity. No persistence needed — excludes apply fresh on every query.

### 2. Glob semantics

Each pattern is matched via `minimatch` against the file path **relative to the search-directory root** that owns the chunk (`path.relative(chunk.directory_path, chunk.file_path)`). Root-relative globs (e.g. `["**/dist/**", "*.log"]`).

### 3. `.git` + `node_modules` always skipped at index time

These are explicit, unconditional `ALWAYS_SKIP_DIRS` in `collectFiles` (search-indexer.ts). `.git` was already skipped via the generic dotfile check; it's now an explicit entry alongside `node_modules`.

### 4. `includeHidden` / `includeNodeModules` marked intended-future

These remain dead flags, explicitly documented as **intended future functionality** in the config types and schema. `.git` and `node_modules` are always excluded regardless.

### 5. `minimatch` added as a direct dep of `drone-beacon`

Previously only a transitive dependency; now a direct dependency (`^10.2.5`, resolved to 10.2.6).

## Implementation

### Beacon — `routes/search.ts`

- `import { minimatch } from 'minimatch';`
- Extended the GET Querystring type with `exclude?: string | string[]`; normalized to `excludePatterns`.
- Added helper:
  ```typescript
  function isExcluded(
    filePath: string,
    rootDir: string,
    patterns: string[]
  ): boolean {
    if (patterns.length === 0) return false;
    const rel = path.relative(rootDir, filePath);
    return patterns.some(p => minimatch(rel, p));
  }
  ```
- In the chunk loop (before cosine similarity): `const rootDir = directoryPath ?? chunk.directory_path; if (isExcluded(chunk.file_path, rootDir, excludePatterns)) continue;`

### Beacon — `search-indexer.ts`

- Added `const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);`
- Directory branch skips `ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')`.
- Exported `collectFiles` for direct unit testing.

### Agent — `plugins/search/index.ts`

- Added `collectExcludes(paths, queryPath)` helper: when a `path` is given, only excludes for matching registered roots; when unscoped, all configured excludes.
- In `handleSemanticSearch`, appends each exclude as a repeated `params.append('exclude', e)`.

### Config — `config-types.ts` / `config-schema.ts`

- jsdoc on `includeHidden`/`includeNodeModules` (intended future; `.git`/`node_modules` always excluded) and `exclude` (minimatch, root-relative, query-time).
- Added `description` strings to the three fields in the TypeBox schema.

## Open Question Resolution

For unscoped queries (no `path`), the agent sends **all** configured excludes, and the beacon matches each glob relative to each chunk's own root. So `["**/dist/**"]` from path A also excludes `**/dist/**` under path B. A stricter per-directory scoping would require a structured param (e.g. `excludesByDir`), which this plan deliberately did not implement.

## Tests

- **`search-indexer.test.ts`** (new) — `collectFiles` skips `.git`, `node_modules`, hidden dirs/files, and binary files; empty-set case.
- **`routes.test.ts`** — search route exclude filtering: seeds two chunks under `/proj`, asserts both returned without `exclude`, only the non-excluded file with `exclude=**/*.log`.
- **`search.test.ts`** (agent) — mock swarm capability + `getConfig` with excludes, stubs `fetch` to capture URL, asserts URL contains `exclude=*.log` and `exclude=**%2Fdist%2F**`.

## Related

- [127-semantic-search-beacon](127-semantic-search-beacon.md) — semantic search moved to the beacon
- semantic-search — the semantic search concept
- [drone-beacon](../../drone-beacon/) — beacon module
- [drone-agent-plugins](../../drone-agent/src/plugins/) — search plugin
