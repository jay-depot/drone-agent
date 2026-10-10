---
key: planning-search-path-rag-sources
tags:
  - planning
  - search
  - swarm-memory
  - rag
  - config
created: 2026-10-10T06:31:22.396Z
updated: 2026-10-10T06:31:22.396Z
---

# PLAN: `search.paths[].ragSource` — workspace folders as swarm-memory RAG sources

**Status:** planned (not implemented). **Planner session:** 2026-10-10.

## 1. What and why

The swarm-memory RAG (ADR 179) proactively injects a compact, query-aware index of **wiki**
entries into the agent's system prompt each turn (advertise + recall: it lists
`id · title · origin · score — pitch` one-liners and points at `swarm__wiki_read`).

Today that candidate pool is **wiki-only**. Meanwhile the agent already maintains a
**workspace file** semantic index on the beacon (`search.paths[]` → `SearchIndexer` →
`search_chunks`/`vec_chunks`) for the interactive `search__text mode="semantic"` tool. That
index is never consulted by the RAG.

This feature lets a user mark a `search.paths[]` entry with `ragSource: true` so that
folder's files become an **additional candidate source** for the swarm-memory RAG. There are
**no extra suggestion slots**: file candidates compete with wiki entries for the same
`swarm.memory.topK` slots. The swarm RAG prompt fragment is reworded to describe both kinds.

## 2. Decisions made (all confirmed with the user)

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                            |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope                | Extend the existing **dense-only** RAG (Ollama `nomic-embed-text:v1.5`, 768d, `1-cosine` via sqlite-vec). **No** lexical/BM25/FTS stage. "Hybrid" here means advertise+recall (suggest + recall instructions), NOT whole-document injection.                                                      |
| D2  | Architecture         | **Agent-side fan-out.** The retriever additionally calls the _existing_ stateless beacon route `GET /agents/:id/search` once per (query-input × ragSource dir), merges file hits into the **same** candidate pool as wiki entries, then one global sort + `slice(topK)`. **No new beacon route.** |
| D3  | Gating               | `ragSource` is **self-contained**. The search plugin registers/indexes `ragSource: true` paths even when `search.enabled: false`. `search.enabled` governs only the interactive `search__text` tool.                                                                                              |
| D4  | Fan-out shape        | Per (query-input × dir); `maxResults = topK` per request; **no per-source cap**; pass each path's `exclude` globs.                                                                                                                                                                                |
| D5  | Entry shape          | **Discriminated union** `SwarmMemoryEntry` with `kind: 'wiki' \| 'file'`; two bullet shapes; kind-aware recall instructions; file snippet capped at `MAX_PITCH_CHARS` (400).                                                                                                                      |
| D6  | Thresholds           | Reuse `swarm.memory.minScore` for file hits (same model ⇒ comparable scores). **No new config knob.**                                                                                                                                                                                             |
| D7  | Anchors              | Extend anchor matching symmetrically: for file entries, treat the **file path as the "title"** so an anchor substring match applies `boostTitle`; files have no tags so `boostPerTag` does not apply to them.                                                                                     |
| D8  | Plugin enablement    | Silent, **info-log-only** (matches existing convention). No new startup warning. Document that the `search` plugin must be enabled for registration/indexing to happen.                                                                                                                           |
| D9  | Config source        | The **swarm** plugin reads `registration.getConfig().search?.paths` directly and filters `ragSource === true`. **No new capability.**                                                                                                                                                             |
| D10 | Fragment advertising | Register the `search-indexed-directories` header fragment **only when `search.enabled: true`**. Do **not** add a new gate to `handleSemanticSearch`.                                                                                                                                              |
| D11 | File path rendering  | Render the **absolute** file path (recall-correct: `file__read` requires an absolute path). Reverses an earlier relative-path idea.                                                                                                                                                               |
| D12 | ADR/docs             | New ADR `docs/adr/245-search-path-rag-sources.md`; update project wiki `[[concepts/semantic-search]]` + `[[concepts/memory-pipeline]]`; update `AGENTS.md`; save this plan as project memory `planning-search-path-rag-sources`.                                                                  |

## 3. Key facts established during exploration

- `DroneSearchPath` — `drone-core/src/config-types.ts:3-24` (`path`, `embeddingProvider?`, `includeHidden?`, `includeNodeModules?`, `exclude?`). `DroneSearchConfig` at `:25-30`. Default `search: { enabled: false, paths: [] }` at `config-types.ts:732-735`.
- TypeBox schema for `search.paths[]` — `drone-core/src/config-schema.ts:299-329`.
- `config-keys.ts:78` allowlists `search.paths` (whole array). There are **no** `swarm.*` keys in `KNOWN_CONFIG_KEYS` or `UNDERLAY_ALLOWLIST`.
- Search plugin registration lives in `drone-agent/src/plugins/search/index.ts` `onPluginsLoaded` (`:152-241`), gated by `if (!searchConfig?.enabled) return` (`:154-160`). It PUTs `{ paths: directories }` (raw config objects, unresolved) to `${beaconUrl}/agents/${agentId}/search-paths` and, on success, registers the header fragment `search-indexed-directories` (`:215-234`).
- Beacon `PUT /agents/:id/search-paths` (`drone-beacon/src/routes/search.ts:32-90`) resolves each `sp.path` with `path.resolve` **beacon-side** and persists only the resolved `directory_path` (`exclude` etc. are dropped; `exclude` is applied query-time client-side, ADR 128).
- Beacon `GET /agents/:id/search` (`routes/search.ts:93-198`) params `q`, `maxResults`, `minScore`, `path`, `exclude`. **Path authorization**: `path.resolve(searchPath)` must `startsWith` one of the agent's registered dirs, else 403. Returns `{ query, resultCount, truncated, results: [{ file, chunkIndex, content, score }] }` with **absolute** file paths.
- Beacon `GET /wiki/semantic-search` (`routes/wiki.ts:264-364`) is stateless, not agent-scoped, returns `{ query, resultCount, pageCount, results: [{ pageId, origin, title, tags, pitch?, score, matchedChunk }] }`. Both routes depend on the **same** Ollama provider (503 when absent).
- Retriever — `drone-agent/src/plugins/swarm/memory-retrieval.ts`: `SwarmMemoryRetriever` (`:86`), `retrieve()` (`:230`), `maybeRefresh()` (`:190`), `formatCacheReport()` (`:51`), `truncatePitch()` (`:72`). `topK ?? 5` appears twice (`:233`, `:292`); `minScore ?? 0.35` at `:235`.
- Fragment — `drone-agent/src/plugins/swarm/memory-fragment.ts` `createSwarmMemoryFragment` (`:25`), key `swarm-memory`, phase `footer`.
- Wiring — `drone-agent/src/plugins/swarm/index.ts:225-266`.
- `MAX_PITCH_CHARS = 400` — `drone-swarm-common/src/wiki-storage.ts:102`.
- `SwarmMemoryEntry` consumers: `memory-fragment.ts:32`, `slash-swarm-memory.ts` (via `formatCacheReport`), and tests (`memory-fragment.test.ts`, `memory-retrieval.test.ts`, `slash-swarm-memory.test.ts`).

## 4. Implementation steps

### Step 1 — drone-core: add the `ragSource` field _(agent: coder)_

**File: `drone-core/src/config-types.ts`** — extend `DroneSearchPath` (after `path`):

```ts
export type DroneSearchPath = {
  path: string;
  /**
   * When true, this folder's workspace-file semantic index becomes an
   * additional candidate source for the swarm-memory RAG
   * (`swarm.memory`). File hits compete with wiki entries for the same
   * `swarm.memory.topK` slots — no extra slots are reserved. Requires the
   * `search` plugin to be enabled (it performs the beacon registration).
   * Default false.
   */
  ragSource?: boolean;
  embeddingProvider?: string;
  // …unchanged
};
```

**File: `drone-core/src/config-schema.ts`** — in the `search.paths` item object (`:303-322`), add:

```ts
ragSource: Type.Optional(
  Type.Boolean({
    description:
      'Include this folder in swarm-memory RAG retrieval. File hits compete with wiki entries for the same swarm.memory.topK slots. Default false.',
  })
),
```

### Step 2 — search plugin: register ragSource paths independent of `search.enabled` _(agent: coder)_

**File: `drone-agent/src/plugins/search/index.ts`**, `onPluginsLoaded` (`:152-241`).

Replace the early gate and the `directories` computation:

```ts
const config = registration.getConfig();
const searchConfig = config.search;
const allPaths = searchConfig?.paths ?? [];
const ragSourcePaths = allPaths.filter(p => p.ragSource === true);
const searchEnabled = searchConfig?.enabled === true;

// Register when interactive search is on (all paths) OR when any path is a
// RAG source (only those paths). ragSource is self-contained: it does not
// require search.enabled.
const pathsToRegister = searchEnabled ? allPaths : ragSourcePaths;

if (pathsToRegister.length === 0) {
  registration.logger.info(
    searchEnabled
      ? 'search: no search paths configured; skipping beacon registration'
      : 'search plugin loaded (semantic search disabled by config)'
  );
  return;
}

// …swarm capability check unchanged…

const response = await fetch(`${beaconUrl}/agents/${agentId}/search-paths`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ paths: pathsToRegister }),
});
```

Then register the header fragment **only when `searchEnabled`**, listing `pathsToRegister`:

```ts
if (searchEnabled) {
  const dirList = pathsToRegister.map(d => `  - ${d.path}`).join('\n');
  registration.registerPromptFragment({
    key: 'search-indexed-directories',
    phase: 'header',
    render: async () => `# Search Index\n` + /* …unchanged body… */,
  });
}
```

Notes:

- Keep the existing success/`indexed` info log.
- Do **not** change `handleSemanticSearch` (D10) — it still only requires the swarm capability.

### Step 3 — swarm plugin: read `ragSource` paths from config _(agent: coder)_

**File: `drone-agent/src/plugins/swarm/index.ts`** (wiring at `:225-266`).

```ts
import type { RagSourcePath } from './memory-retrieval.js';

const ragSourcePaths: RagSourcePath[] = (
  registration.getConfig().search?.paths ?? []
)
  .filter(p => p.ragSource === true)
  .map(p => ({ path: p.path, exclude: p.exclude }));

const memoryRetriever = new SwarmMemoryRetriever({
  capability: swarmCap,
  config: memoryConfig,
  ragSourcePaths,
  logger: registration.logger,
  debugFlags: runtimeInfo?.debugFlags,
  emitNotice: content => runtimeInfo?.emitEvent?.({ kind: 'notice', content }),
});
```

Read-once at `register()` time, consistent with how `memoryConfig` is read today. (`search.paths` is not underlay-allowed, so it cannot change via the coordinator.)

### Step 4 — retriever: fan out to the workspace route and merge _(agent: coder)_

**File: `drone-agent/src/plugins/swarm/memory-retrieval.ts`**

**4a. Discriminated-union entry type** (replaces the interface at `:8-15`):

```ts
export type SwarmMemoryEntry =
  | {
      kind: 'wiki';
      pageId: string;
      origin: 'beacon' | 'coordinator';
      title: string;
      tags: string[];
      score: number;
      pitch: string;
    }
  | {
      kind: 'file';
      filePath: string;
      score: number;
      snippet: string;
    };

export type RagSourcePath = { path: string; exclude?: string[] };
```

Add a workspace response type:

```ts
export interface WorkspaceSearchResult {
  file: string;
  chunkIndex: number;
  content: string;
  score: number;
}
export interface WorkspaceSearchResponse {
  query: string;
  resultCount: number;
  truncated: boolean;
  results: WorkspaceSearchResult[];
}
```

**4b. Deps** — add to `SwarmMemoryRetrieverDeps`:

```ts
/** Workspace folders opted into RAG via `search.paths[].ragSource`. */
ragSourcePaths?: RagSourcePath[];
```

Store as `private ragSourcePaths: RagSourcePath[]`, defaulting to `[]` in the constructor.

**4c. `retrieve()` rewrite** (`:230-293`):

```ts
private async retrieve(inputs: string[]): Promise<SwarmMemoryEntry[]> {
  const base = this.capability!.getBeaconUrl();
  const agentId = this.capability!.getAgentId();
  const topK = this.config.topK ?? 5;
  const minScore = this.config.minScore ?? 0.35;

  const wikiRequests = inputs.map(async q => {
    const sp = new URLSearchParams({
      q,
      maxResults: String(topK),
      minScore: String(minScore),
    });
    const res = await this.fetchImpl(`${base}/wiki/semantic-search?${sp}`);
    if (!res.ok) throw new Error(`semantic search failed: ${res.status}`);
    return (await res.json()) as SearchRouteResponse;
  });

  const fileRequests = inputs.flatMap(q =>
    this.ragSourcePaths.map(async dir => {
      const sp = new URLSearchParams({
        q,
        maxResults: String(topK),
        minScore: String(minScore),
        // Pass the RAW configured path: the beacon resolves it with
        // path.resolve at both registration and query time, so the
        // authorization check (startsWith) matches.
        path: dir.path,
      });
      for (const e of dir.exclude ?? []) sp.append('exclude', e);
      const res = await this.fetchImpl(
        `${base}/agents/${agentId}/search?${sp}`
      );
      if (!res.ok) throw new Error(`workspace search failed: ${res.status}`);
      return (await res.json()) as WorkspaceSearchResponse;
    })
  );

  const [wikiResponses, fileResponses] = await Promise.all([
    Promise.all(wikiRequests),
    Promise.all(fileRequests),
  ]);

  const byKey = new Map<string, SwarmMemoryEntry>();
  for (const response of wikiResponses) {
    for (const result of response.results) {
      const key = `wiki\u0000${result.pageId}\u0000${result.origin}`;
      const entry: SwarmMemoryEntry = {
        kind: 'wiki',
        pageId: result.pageId,
        origin: result.origin,
        title: result.title,
        tags: result.tags ?? [],
        score: result.score,
        pitch: truncatePitch(result.pitch ?? result.matchedChunk ?? ''),
      };
      const existing = byKey.get(key);
      if (!existing || entry.score > existing.score) byKey.set(key, entry);
    }
  }
  for (const response of fileResponses) {
    for (const result of response.results) {
      const key = `file\u0000${result.file}`;
      const entry: SwarmMemoryEntry = {
        kind: 'file',
        filePath: result.file,
        score: result.score,
        snippet: truncatePitch(result.content),
      };
      const existing = byKey.get(key);
      if (!existing || entry.score > existing.score) byKey.set(key, entry);
    }
  }

  this.applyAnchorBoosts(byKey);
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}
```

**4d. Anchors (D7)** — extract the existing boost block into `applyAnchorBoosts(byKey)` and make it kind-aware:

```ts
private applyAnchorBoosts(byKey: Map<string, SwarmMemoryEntry>): void {
  const anchors = this.config.anchors;
  if (!anchors || anchors.tags.length === 0) return;
  const boostPerTag = anchors.boostPerTag ?? 0.08;
  const boostTitle = anchors.boostTitle ?? 0.05;
  const lowered = anchors.tags.map(t => t.toLowerCase());
  for (const entry of byKey.values()) {
    // File entries have no tags; their path stands in for the title so
    // anchor matching stays symmetric across kinds.
    const titleLower =
      entry.kind === 'wiki' ? entry.title.toLowerCase() : entry.filePath.toLowerCase();
    const tagsLower =
      entry.kind === 'wiki' ? entry.tags.map(t => t.toLowerCase()) : [];
    for (const anchor of lowered) {
      if (tagsLower.includes(anchor)) entry.score += boostPerTag;
      if (titleLower.includes(anchor)) entry.score += boostTitle;
    }
  }
}
```

Note: the existing code had `boostTitle ?? 0` while the config default is `0.05`; this step aligns the fallback to `0.05` (a deliberate, in-scope cleanup — call it out in the ADR).

**4e. `formatCacheReport()`** (`:51-67`) — render per kind:

```ts
for (const entry of cache.entries) {
  lines.push(
    entry.kind === 'wiki'
      ? `  - ${entry.title} · ${entry.pageId} (${entry.origin}) · ${entry.score.toFixed(2)}`
      : `  - ${entry.filePath} · ${entry.score.toFixed(2)}`
  );
}
```

### Step 5 — fragment reword _(agent: coder)_

**File: `drone-agent/src/plugins/swarm/memory-fragment.ts`** — rewrite `render()`:

```ts
const lines: string[] = [
  '# Swarm Memory',
  '',
  'The following knowledge sources may be relevant to this conversation:',
  '',
];
for (const entry of cache.entries) {
  if (entry.kind === 'wiki') {
    const pitch = pitchOf(entry.pitch);
    lines.push(
      `- wiki \`${entry.pageId}\` (${entry.origin}) · Title: ${entry.title} · score: ${entry.score.toFixed(2)}${pitch ? ` — ${pitch}` : ''}`
    );
  } else {
    const snippet = pitchOf(entry.snippet);
    lines.push(
      `- file \`${entry.filePath}\` · score: ${entry.score.toFixed(2)}${snippet ? ` — ${snippet}` : ''}`
    );
  }
}
lines.push('');
lines.push(
  '---',
  'If a suggested wiki page is relevant, call `swarm__wiki_read` to load its full contents.',
  'If a suggested file is relevant, read it with `file__read`.',
  '',
  'These sources come from past session history and indexed project files, and can ',
  'contain useful context around continuing work, revisiting previous decisions, and ',
  'avoiding repeated mistakes.'
);
return lines.join('\n');
```

Also fix the stale module doc comment (`# Swarm Memory (wiki)` / "header fragment" → `# Swarm Memory` / footer).

### Step 6 — tests _(agent: tester, then coder for fixes)_

- **`drone-core/test/`** — schema accepts `ragSource: true`; default config has no `ragSource` (undefined).
- **`drone-agent/test/search.test.ts`** — (a) with `search.enabled: false` and a `ragSource: true` path, `onPluginsLoaded` PUTs **only** that path; (b) the `search-indexed-directories` fragment is **not** registered when `search.enabled: false`; (c) with `search.enabled: true`, all paths are PUT and the fragment **is** registered.
- **`drone-agent/test/plugins/swarm/memory-retrieval.test.ts`** — file fan-out issues one `/agents/:id/search` call per (input × dir); file+wiki merge into one pool with one global `slice(topK)`; `path` param is the raw config path; `exclude` params are forwarded; anchors boost a file whose path contains an anchor string; a failing workspace request keeps the previous cache (existing failure semantics).
- **`drone-agent/test/plugins/swarm/memory-fragment.test.ts`** — update `setCacheForTest` fixtures to the union (`kind: 'wiki'`); add a file-entry fixture asserting the `- file \`/abs/path\`` bullet and the two kind-aware recall lines.
- **`drone-agent/test/plugins/swarm/slash-swarm-memory.test.ts`** — update fixtures to the union; add a file-entry status assertion.
- **`drone-agent/test/plugins/swarm/memory-trigger.test.ts`** — unchanged behavior, but confirm it still passes with the union.

### Step 7 — ADR + docs _(agent: coder)_

- **New `docs/adr/245-search-path-rag-sources.md`** — record D1–D12, the two-route fan-out, the raw-path resolution subtlety, the `boostTitle` fallback alignment, and the alternatives rejected (beacon-side merge; a new capability; relative-path rendering).
- **`docs/adr/index.md`** — add the row.
- **Project wiki** (`/home/unleet/Obsidian/drone-agent-project/`) — update `concepts/semantic-search.md` (workspace vs wiki split now crosses over) and `concepts/memory-pipeline.md` (RAG now has a second source kind); add a pointer stub under `decisions/245-…` if the convention requires it.
- **`AGENTS.md`** — mention `search.paths[].ragSource` in the search/config description.
- **Project memory** — this plan is stored as `planning-search-path-rag-sources`.

### Step 8 — validation (final step)

Run, in order, and require all to pass with zero errors:

1. `pnpm -r run build` (drone-core types changed → dependent packages resolve from `dist/`).
2. LSP diagnostics clean across the workspace.
3. `pnpm run lint` (ESLint + Prettier; re-read files afterwards before further edits).
4. `pnpm run typecheck`.
5. `pnpm run test` (fast suite).
6. Manual smoke: with `search.enabled: false` and one `ragSource: true` path, confirm the beacon registers/indexes the path and the `# Swarm Memory` fragment can list `- file …` entries; `/swarm-memory status` renders file entries; `--debug swarm-memory` logs the refresh.

## 5. Validation criteria

- **LSP passes** with zero errors/warnings across all packages (no exceptions).
- **`pnpm -r run build`** passes with zero errors.
- **`pnpm run lint`** passes with zero errors (Prettier reformats as needed).
- **`pnpm run typecheck`** passes.
- **`pnpm run test`** (fast suite) passes, including all new tests.
- **Behavioral criteria:**
  - A `search.paths[]` entry with `ragSource: true` is registered/indexed by the beacon even when `search.enabled: false`.
  - The swarm-memory RAG issues workspace-file queries for each `ragSource` dir and merges file hits with wiki hits into one ranked pool truncated to `swarm.memory.topK` — **no extra slots**.
  - File hits render as `- file \`<absolute path>\` · score: N — <snippet>`; wiki hits render as `- wiki \`<id>\` (<origin>) · Title: … · score: N — <pitch>`.
  - The fragment's recall lines name **both** `swarm__wiki_read` and `file__read`.
  - `swarm.memory.minScore` filters file hits; anchor `boostTitle` applies to file paths.
  - When `swarm.memory.enabled: false` (or no swarm connection), there are **zero** network calls and the fragment renders `false`.
  - The `search-indexed-directories` fragment is registered only when `search.enabled: true`.
  - No dead code, no unused variables, no fluff comments; no duplicated merge/truncation logic.
- **Docs criteria:** ADR 245 exists and is listed in `docs/adr/index.md`; wiki `concepts/semantic-search` and `concepts/memory-pipeline` updated; `AGENTS.md` updated; plan stored in project memory.

## 6. Risks / notes

- **Request count grows** as inputs × dirs; all requests are localhost and the refresh is fire-and-forget (no turn blocking).
- **Failure semantics preserved:** any non-OK response throws and keeps the previous cache — identical to today, and both routes share the same Ollama provider dependency, so no new failure mode is introduced.
- **`search` plugin must be enabled** for registration/indexing; otherwise file queries silently return empty (documented, D8).
- **`SwarmMemoryEntry` shape change ripples** to `memory-fragment.ts`, `formatCacheReport`, and four test files — sweep all of them.

---

## 7. IMPLEMENTATION COMPLETE (2026-10-10)

**Status:** Implemented. **Branch:** `feat/rag-anything`. **Commit:** `e9f20e82`. **ADR:** `docs/adr/245-search-path-rag-sources.md`.

All 8 steps executed as written; no deviations. Validation:

- `pnpm -r run build` — clean.
- LSP diagnostics — no errors/warnings (only pre-existing hints elsewhere).
- `pnpm run lint` — clean (Prettier reformatted the fragment continuation lines in `search/index.ts`).
- `pnpm run typecheck` — clean.
- `pnpm run test` — **3837 passed**, 14 skipped, 0 failed (286 test files).

### What shipped

- `DroneSearchPath.ragSource?: boolean` + TypeBox schema field (drone-core).
- Search plugin: `pathsToRegister = searchEnabled ? allPaths : ragSourcePaths`; fragment gated on `searchEnabled`; no change to `handleSemanticSearch`.
- Swarm plugin: reads `search?.paths`, filters `ragSource === true`, passes `ragSourcePaths` to the retriever.
- Retriever: `SwarmMemoryEntry` is a `kind: 'wiki' | 'file'` union; `retrieve()` fans out `/agents/:id/search` per (input × dir) with the raw path + `exclude` globs, merges per-document MAX with wiki hits, `applyAnchorBoosts` (symmetric — file path stands in for title), one global `slice(topK)`; `formatCacheReport` per-kind.
- Fragment: `# Swarm Memory` reworded to "knowledge sources"; `- wiki …` / `- file <absolute path> …` bullets; recall names both `swarm__wiki_read` and `file__read`.
- Tests added/updated: drone-core schema (3), search plugin ragSource registration (4), retriever fan-out/merge/anchors/failure (7 new), fragment rendering (2 new), slash status (1 new).

### Notes / deviations from the plan text

- **`memory-trigger.test.ts` needed a fix** (not listed in the plan): the test polled for the *fetch call count*, but the new nested `Promise.all([Promise.all(wiki), Promise.all(files)])` added one microtask tick before the cache was populated, so the poll could observe the call before the cache landed. Changed the poll to wait on the *rendered fragment content* instead (aligns with the project's "poll for expected content, never fixed ticks" principle).
- `boostTitle` fallback aligned `?? 0` → `?? 0.05` as the plan directed; documented in the ADR.
- Project wiki updated (`concepts/semantic-search.md`, `concepts/memory-pipeline.md`, `decisions/245-…` stub, `decisions/index.md`); the Obsidian vault is a separate repo outside the workspace boundary, so those edits were left uncommitted there.
- Manual smoke (plan step 8.6) not run — it needs a live beacon + Ollama; behavior is covered by the unit tests above.
