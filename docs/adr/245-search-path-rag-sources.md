---
tags:
  [
    decision,
    search,
    swarm,
    memory,
    rag,
    semantic-search,
    config,
    prompt-fragments,
    beacon,
    embeddings,
    adr,
  ]
related:
  [
    decisions/179-swarm-memory-rag-retrieval.md,
    decisions/184-swarm-memory-retrieval-trigger-fix.md,
    decisions/128-search-exclude-query-time-filtering.md,
    decisions/150-semantic-search-prompt-surface.md,
    decisions/181-bit-signature-prefilter-semantic-search.md,
    concepts/semantic-search.md,
    concepts/memory-pipeline.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
    modules/drone-beacon.md,
    modules/drone-core.md,
  ]
---

# 245: `search.paths[].ragSource` — workspace folders as swarm-memory RAG sources

**Status**: Implemented (2026-10-10) · **Branch**: `feat/rag-anything` · **Plan**: project-memory `planning-search-path-rag-sources`

**Summary**: The swarm-memory RAG ([179](179-swarm-memory-rag-retrieval.md)) proactively injects a compact, query-aware index of **wiki** entries into the agent's system prompt each turn (advertise + recall). Its candidate pool was **wiki-only**, even though the agent already maintains a **workspace-file** semantic index on the beacon for the interactive `search__text mode="semantic"` tool. This decision adds an optional boolean **`ragSource`** (default `false`) to each `search.paths[]` entry: when true, that folder's file hits become an additional candidate source for the swarm-memory RAG. There are **no extra suggestion slots** — file hits compete with wiki entries for the same `swarm.memory.topK` slots. The swarm RAG prompt fragment is reworded to describe both kinds.

## Context

Two separate dense vector stores already exist on the beacon, sharing one embedding stack (Ollama `nomic-embed-text:v1.5`, 768 dims, `1 - cosine` scores):

- **Workspace files** — `search_directories`/`search_files`/`search_chunks` + `vec_chunks`/`vec_chunks_bq`, fed by `SearchIndexer`, queried by `GET /agents/:id/search`.
- **Wiki corpus** — `wiki_sources`/`wiki_chunks`/`wiki_vec_chunks`, fed by `WikiIndexer`, queried by `GET /wiki/semantic-search`.

Because both use the same model and the same score definition, their scores are directly comparable — so a single merged ranking is meaningful.

The swarm-memory retriever (`drone-agent/src/plugins/swarm/memory-retrieval.ts`) already fans out **one request per query input** and merges by per-document MAX score before slicing to `swarm.memory.topK`. Extending it to a second route is a natural fit.

Terminology note: this decision deliberately does **not** add a lexical/BM25/FTS stage. "Hybrid" in the original request meant the advertise+recall presentation (suggest one-liners + recall instructions), not hybrid retrieval. The pipeline remains **dense-only**.

## Decision

**1. Config.** `DroneSearchPath` gains `ragSource?: boolean` (default false), mirrored in the TypeBox `search.paths[]` schema. `search.paths` is already allowlisted in `KNOWN_CONFIG_KEYS`; it remains **not** underlay-allowed, so the value is user/project-file-only (consistent with the rest of `search.*`).

**2. Gating is decoupled.** `ragSource` is **self-contained**: the search plugin registers and indexes `ragSource: true` paths **even when `search.enabled: false`**. `search.enabled` governs only the interactive `search__text` tool. The registration gate becomes `pathsToRegister = searchEnabled ? allPaths : ragSourcePaths`, with an info-log-and-return when the resulting list is empty (matching the existing silent convention — no new warning). The `search-indexed-directories` **header fragment** is registered **only when `search.enabled: true`**, because it advertises the interactive tool; a passive RAG source must not silently turn that advertisement on. `handleSemanticSearch` gains **no** new gate.

**3. Agent-side fan-out, no new beacon route.** The retriever issues, in parallel:

- `GET {beacon}/wiki/semantic-search?q&maxResults&minScore` — once per query input (unchanged).
- `GET {beacon}/agents/:id/search?q&maxResults&minScore&path&exclude…` — once per (query input × ragSource dir).

Both routes already exist and are stateless. The `path` parameter carries the **raw configured path** (not a pre-resolved one): the beacon resolves it with `path.resolve` at both registration and query time, so the route's `startsWith` authorization check matches. Each path's `exclude` globs are forwarded as repeated `exclude` params (the same patterns the interactive tool already sends, per [128](128-search-exclude-query-time-filtering.md)).

`maxResults = topK` per request; **no per-source cap** and no reserved slots — pure competition, then one global `sort(score desc).slice(topK)`.

**4. Discriminated-union entry.** `SwarmMemoryEntry` becomes a union:

```ts
| { kind: 'wiki'; pageId; origin; title; tags; score; pitch }
| { kind: 'file'; filePath; score; snippet }
```

Merge keys are `wiki\0<pageId>\0<origin>` and `file\0<filePath>`; per-document MAX wins within each kind. The file `snippet` is the best-matching chunk's content, capped at `MAX_PITCH_CHARS` (400) — the same cap the wiki pitch uses.

**5. Thresholds and anchors.** File hits reuse `swarm.memory.minScore` (no new knob) — justified by the shared embedding stack. Anchor boosts become **symmetric**: a file entry has no tags, so its **path stands in for the title**, and an anchor substring match applies `boostTitle`; `boostPerTag` applies only to wiki entries (which have tags). This removes the systematic wiki bias anchors would otherwise introduce. The anchor code is extracted into `applyAnchorBoosts(byKey)` and its `boostTitle` fallback is aligned from `?? 0` to `?? 0.05` to match the config default.

**6. Prompt fragment reword.** `# Swarm Memory` now says "The following knowledge sources may be relevant to this conversation" and renders two bullet shapes:

- `- wiki \`<id>\` (<origin>) · Title: … · score: N — <pitch>`
- `- file \`<absolute path>\` · score: N — <snippet>`

Recall instructions name both tools — `swarm__wiki_read` for wiki pages, `file__read` for files. The closing framing mentions both past session history **and** indexed project files.

**7. File paths render absolute.** `file__read` requires an absolute path, and the beacon returns absolute paths, so the bullet carries the absolute path verbatim. (An earlier relative-to-root idea was rejected: recall would break for any root other than the cwd.)

**8. Config source.** The swarm plugin reads `registration.getConfig().search?.paths` directly at `register()` time and filters `ragSource === true`; no new capability and no new dependency edge.

**9. Control surface.** `/swarm-memory status` renders file entries by path; `formatCacheReport` is kind-aware.

## Alternatives considered

- **Beacon-side merge** (one new route querying both vector stores). Rejected: a new route + new server-side merge logic, and the agent would still have to tell the beacon which dirs are ragSources. Agent-side fan-out reuses both existing stateless routes and keeps merge/ranking in one place (the retriever), matching its existing per-input fan-out.
- **A `search` capability exposing `getRagSourcePaths()`** for the swarm plugin to consume. Rejected: adds a capability + a dependency edge whose only consumer is one call site, plus an absent-capability path; the config is already the shared source of truth for both plugins.
- **Requiring `search.enabled: true`** for `ragSource`. Rejected: couples two unrelated features and is a silent footgun. `ragSource` is a self-contained "index this folder for RAG" flag.
- **Relative-path rendering.** Rejected: breaks `file__read` recall (see decision 7).
- **Per-source result caps.** Rejected: the requirement is explicitly pure competition for the same `topK` slots.

## Consequences

- A user can feed project folders into the proactive RAG without enabling the interactive semantic-search tool.
- The retriever now makes up to `(queryInputs × (1 + ragSourceDirs))` beacon requests per refresh. All are localhost and the refresh is fire-and-forget (never blocks a turn), so the cost is bounded and off the critical path.
- Failure semantics are unchanged: any non-OK response throws and the retriever keeps its previous cache. Both routes share the same Ollama provider, so no new failure mode is introduced.
- The `search` plugin must be enabled for registration/indexing to happen at all; otherwise `ragSource` paths are simply never indexed and file queries return nothing. This is documented in the `ragSource` field's JSDoc.
- `SwarmMemoryEntry`'s shape change rippled to `memory-fragment.ts`, `formatCacheReport`, and four test files (all updated).
- `swarm.memory` remains absent from the TypeBox `swarm` schema and from the underlay allowlist — a pre-existing gap, unchanged by this decision.
