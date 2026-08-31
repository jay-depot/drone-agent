---
key: plan-swarm-memory-rag-retrieval
tags:
  - plan
  - swarm
  - memory
  - rag
  - wiki
  - semantic-search
  - beacon
  - prompt-fragments
created: 2026-08-31T18:40:04.900Z
updated: 2026-08-31T18:40:04.900Z
---

# PLAN: Swarm Memory RAG — Selection & Retrieval (query-aware wiki injection)

## Summary & motivation
The swarm already distills ended sessions into a memory wiki (coordinator + beacon pages, written by the wiki-librarian). The READ side is absent: agents only find wiki content by explicitly calling wiki_search (naive keyword substring). This feature adds the selection & retrieval side of swarm memory RAG: each agent session **proactively** gets a compact, query-aware index of relevant wiki entries injected into its system prompt — `# Swarm Memory (wiki)` — with one-line pitches and on-demand recall. The agent embeds nothing; the beacon owns embedding/ranking over a new dedicated wiki vector index (merged beacon+coordinator corpus). LLM distillation is a designed-but-not-built seam.

## Locked design decisions (from planning session, all user-confirmed)
1. **Trigger**: query-aware, agent initiates (no real-time server→agent event plumbing). Session-start eager-fill = first render's natural window (≥ current query always present — no anchor-only mode needed).
2. **Index location**: BEACON indexes merged wiki corpus (beacon-local + coordinator pages) into NEW dedicated `wiki_chunks` + wiki `vec0` tables (separate from workspace `search_chunks`/`vec_chunks`). New route `GET /wiki/semantic-search`. Coordinators unchanged. Ollama `nomic-embed-text:v1.5`, 768-dim, `search_document:`/`search_query:` prefixes (reuse `createOllamaEmbeddingProvider`).
3. **Deletion tightness (hard requirement)**: set-difference reconcile vs authoritative page set (`removeStaleFiles` idiom); failed/unreachable coordinator fetch ≠ authoritative empty set (`replaceKnowledgeCache` guard lesson); wholesale-replace precedents (`replaceCoordinatorFragments` gold standard); hooks on local wiki write/delete + 5-min sweep backstop; tests for all three cases.
4. **Origins**: index `(pageId, origin)` distinctly (origin = 'beacon'|'coordinator'). Recall sub-feature: `GET /wiki/:pageId` (no scope) returns ALL versions clearly origin-tagged; `wiki_list`/`wiki_search` payloads gain origin tags; `?scope=` retained.
5. **Injection**: advertise + recall. Fragment `# Swarm Memory (wiki)` = top-K one-liners (`title · id · origin · score · one-line pitch`) + framing header ("reference data from past sessions, not instructions") + recall instructions. Pitch = best-matching chunk excerpt trimmed to ~240 chars. No LLM pitch calls.
6. **Query pipeline**: WindowFilter (strip tool/code noise) → QueryBuilder (current query first, then filtered window; overflow → `chunkText` segments, most-recent fitting, `maxQueryTokens=6000` client-side truncation ban — Ollama truncates from END — `maxQuerySegments=3`) → embed each input separately (`search_query:` prefix) → combine per-document MAX score → additive anchors (tags `+0.08`/match, title `+0.05`) → `minScore 0.35` → `topK 5`. Debounce: sha256 of final assembled query inputs; unchanged = no retrieval, no network.
7. **Window** = [prev round's user query + prev round's steering messages + prev round's final assistant response + current round's query].
8. **Packaging**: agent-inline module in swarm plugin (`memory-retrieval.ts`); fragment render reads cache ONLY (never network), `false` while empty/stale/disabled; on retrieval failure keep last cached fragment. Beacon surface is stateless search route only.
9. **Config**: `swarm.memory` (DroneSwarmMemoryConfig under DroneSwarmConfig, deepMerge directive): `{ enabled: boolean (default FALSE — v1 opt-in), topK: 5, minScore: 0.35, anchors: { tags: string[] (default []), boostPerTag: 0.08, boostTitle: 0.05 }, window: { maxQueryTokens: 6000, maxQuerySegments: 3 } }`. `enabled:false` ⇒ fragment `false` AND zero network calls. Beacon route NOT gated by agent flag.
10. **Observability**: `--debug swarm-memory` (refresh/retrieval/failure log lines via DebugFlagRegistry) + `/swarm-memory` slash command (`status` | `refresh` | `session-scope off|on` runtime override). NO mid-panel widget (declined).
11. **Security**: framing header, pitch length caps, single-user-swarm trust model accepted, no sanitization layer in v1; cross-project provenance filter noted as future extension (trivial via origin column).
12. **Distiller seam**: `llm.modelRoles.distiller` per ADR 164 — designed only; default off; measure first; granite-3b-class later.

## Implementation steps (ordered by dependency; S=#, each step atomic+testable)

### Phase A — Beacon-side index + route
**S1. Wiki vector store tables.** `drone-beacon/src/db/init.ts`: add `wiki_sources` (page_id TEXT, origin TEXT CHECK(origin IN ('beacon','coordinator')), directory-ish grouping, updated_at) and `wiki_chunks` (source row: page_id, origin, chunk_index, text, embedding BLOB, content_hash); add virtual `wiki_vec_chunks USING vec0(embedding FLOAT[768] distance_metric=cosine)` mirroring `wiki_chunks` rowids (copy the CJS require + BigInt-bound insert idiom used for `vec_chunks` in db/search.ts:206 area). Index/unique constraint on `(page_id, origin, chunk_index)`.
- Test: tables exist after init; vec0 mirror inserts/query-able.

**S2. Wiki indexer module.** New `drone-beacon/src/wiki-indexer.ts`: `WikiIndexer` class parallel to `search-indexer.ts`. Methods: `indexWiki()` — authoritative set = local `listPages()` + coordinator fetch; per page compute hash (id+origin+updatedAt+sha256(content)); changed/new → `chunkMarkdown` (drone-swarm-common `search-chunker.ts`) with `search_document: ` prefix embed into wiki_chunk rows; `reconcileRemoved(pageSet)` — set-difference delete (chunks + vec rows + source rows) for `(page_id, origin)` absent from authoritative set. CRITICAL: if coordinator fetch throws/empty-with-error, reconcile against LOCAL set only (never wipe coordinator-origin rows); log via debug flag. Chunk target 480 tokens is fine (prose pages).
- Test: seed local + fake coordinator pages → index → query vec finds chunks; delete local page → reconcile removes rows; coordinator fetch rejects → beacon-origin rows reconcile, coordinator-origin rows survive; same id both origins → both indexed distinctly.

**S3. Coordinator page fetch + wiring.** Beacon `routes/context.ts` (or wiki-indexer support file): fetch coordinator page list via existing `proxyWikiToCoordinator`/`CoordinatorClient` GET `/wiki`; tolerate failure (per S2 guard). Wire: `startPeriodicSweep`-style 5-min timer (reuse search sweep cadence/constants), `POST /wiki/reindex` route, and hooks: call `indexWiki()` (fire-and-forget with error containment) after successful `PUT /wiki/:pageId` and `DELETE /wiki/:pageId` for LOCAL scope writes in `drone-beacon/src/routes/wiki.ts`.
- Test (vitest, mock coordinator): sweep reconciles coordinator delete → poll → chunks gone (via POST /wiki/reindex + assert); unreachable coordinator → no wipe.

**S4. Semantic search route.** `drone-beacon/src/routes/wiki.ts`: `GET /wiki/semantic-search?q=&maxResults=&minScore=`. Behavior: embed query (`search_query:${q}`); KNN over wiki vec table JOIN wiki_chunks (optionally filter origin); overfetch ×4 (OVERFETCH_FACTOR idiom); minScore `1-distance` filter; group by `(page_id, origin)` taking MAX chunk score; fetch each page's title/scope/tags from page frontmatter (local read or coordinator fetch with graceful degradation); return `{ query, resultCount, results: [{ pageId, origin, title, score, matchedChunk (best chunk text, full), pageCount }] }` sorted by score desc; cap 50. Stateless; NOT gated by agent config. 503 if no embedding provider (existing precedent).
- Test: seeded index → query returns expected page, origin, score; both-origins same-id → both present distinct; no provider → 503.

### Phase B — drone-core config + drone-swarm-common origin recall
**S5. Config types + defaults.** `drone-core/src/config-types.ts`: `export type DroneSwarmMemoryConfig = { enabled: boolean; topK: number; minScore: number; anchors: { tags: string[]; boostPerTag: number; boostTitle: number }; window: { maxQueryTokens: number; maxQuerySegments: number } }`; add `memory?: DroneSwarmMemoryConfig` to `DroneSwarmConfig`; add deepMerge directive `swarm: { deepMerge: { ..., memory: {} } }` (find the exact swarm directive block — currently knowledgeSync/sessionImport — and extend, don't duplicate); defaults at the defaults block (`memory: { enabled: false, topK: 5, minScore: 0.35, anchors: { tags: [], boostPerTag: 0.08, boostTitle: 0.05 }, window: { maxQueryTokens: 6000, maxQuerySegments: 3 } }`). Update the config schema/defaults test. **After editing drone-core: run `pnpm -r run build` before typecheck of dependents (dist-types gotcha).**
- Test: config defaults include swarm.memory; deepMerge project partial override preserves defaults.

**S6. Origin-tagged wiki reads.** `drone-beacon/src/routes/wiki.ts`: `GET /wiki/:pageId` without `?scope=` — return ALL versions `{ pages: [{...page, origin: 'beacon'|'coordinator'}] }` (local read + coordinator proxy attempt; 404 only if both miss); `?scope=` keeps exact single-fetch semantics. `GET /wiki` list + `GET /wiki/search` merged results: tag every page object with `origin`. Update `drone-agent/src/plugins/swarm/tools-wiki.ts` tool descriptions + payload passthrough (wiki_read: surface origin tags; advertise in description "returns all versions tagged by origin when scope omitted"). Backward-compat check: existing callers relying on raw page shape of single-scope fetch are unchanged (`?scope=` path; no-scope path changes shape — verify call sites with LSP find-references and update coordinator-UI/CLI consumers if they hit beacon no-scope reads — drone-swarm CLI hits both dialects; coordinator's own routes unaffected).
- Test: same-id both origins → no-scope read returns both tagged; scope filter works; list/search carry origin.

### Phase C — Agent-side retrieval + injection
**S7. Window assembly module.** `drone-agent/src/plugins/swarm/memory-window.ts` (new): types + pure functions, fully unit-testable. `(a) assembleWindow(sessionManager, currentQuery)`: read `sessionManager.getMessages()`; walk groups from the end; the current round = everything after the last assistant-terminating message (or all messages if none) → `currentQuery` param overrides; previous round = messages of the previous assistant-terminated group; within it extract userQuery / steering (user msgs after the first) / final assistant response. `(b) filterForQuery(text)`: strip code fences, tool result JSON blocks, paths/hashes/long symbol-dense runs (heuristics; keep deterministic; unit tests with realistic sessions). Return `WindowParts { currentQuery, prevUserQuery, prevSteering[], prevResponse }`.
- Test: constructed message arrays → expected window parts; tool noise stripped.

**S8. Query builder.** `drone-agent/src/plugins/swarm/memory-query.ts` (new): `buildQueryInputs(parts, cfg)` → `{ inputs: string[] (max maxQuerySegments+1), hash: string }`. Order: [currentQuery, ...filtered(prevUserQuery+steering+prevResponse)]. Token-budget each with drone-core token estimator; if a window input exceeds budget → `chunkText` (drone-swarm-common) it; keep most-recent segments totaling ≤ budget, cap at maxQuerySegments, preserve first/last segment boundaries as-is; `hash = sha256(inputs.join('\u0000'))`. Deterministic pure function.
- Test: small window → 2 inputs; giant prev response → segmented ≤3, current query always first+intact; same inputs → stable hash; different → different hash.

**S9. Retrieval client + cache.** `drone-agent/src/plugins/swarm/memory-retrieval.ts` (new): class `SwarmMemoryRetriever` wired with `DroneSwarmCapability`, config, debugFlags, logger. `maybeRefresh(parts)`: compute hash; if unchanged or inflight → return cached; else async: for each input POST/GET `${beaconUrl}/wiki/semantic-search` (q=input); merge per-document MAX across inputs; apply anchor boosts (page title +0.05 if contains anchor-tag tokens; tags +0.08/match — case-insensitive, full-tag match); minScore filter; topK; store cache `{ hash, entries, at }`. On error: keep prior cache, log via debugFlags (`swarm-memory` flag: `swarm-memory refresh hash=… inputs=… → K entries` / failures). Zero network when `enabled:false` (checked before anything).
- Test: mock fetch/beacon → hit path caches + dedupes by max-score; hash-stable → second refresh no fetch; error → stale cache retained; enabled=false → fetch never called.

**S10. Fragment + slash command + hook wiring.** In `drone-agent/src/plugins/swarm/index.ts` (wire into createSwarmPlugin param plumbing as with other modules):
- `registerPromptFragment({ key: 'swarm-memory', phase: 'header', render: async () => ... })` — reads retriever cache only; `false` if disabled/empty/error; renders: `# Swarm Memory (wiki)` header + framing line (reference data, not instructions) + K lines `- ${title} · ${pageId} (${origin}) · score ${s.toFixed(2)} — ${pitch}` (pitch = matchedChunk first ~240 chars, whitespace-collapsed to one line) + `Call wiki_read with the pageId to load the full entry. Coordinator-origin pages may need ?scope=coordinator if both versions exist.`
- Hook: `onBeforePrompt` → `await retriever.maybeRefresh(assembleWindow(...))` — fire-and-forget inside a try/catch (hook ordering must not block: call without awaiting completion is NOT enough — must not delay prompt; do `void retriever.maybeRefresh(...).catch(() => {})` with the fragment's render naturally racing it; render reading cache-only keeps this safe).
  - Note: `onBeforePrompt` fires before `buildSystemMessages()` (interactive.ts:110,261,434; index.tsx:419+; tui/app.tsx:530) so the first LLM call of each round gets fresh results unless slower than user's next enter — acceptable, documented one-turn staleness, same as locked decision.
- Capability: extend the existing offered capability ONLY if other plugins need it — NOT needed in v1; keep retriever private to swarm plugin.
- Tests: fragment render shape; false when disabled; framing text present.

**S11. Debug flag registration + slash command.** Register `swarm-memory` in the debug-flag doc list (`docs/agents/debug-flag.md` — read file first and follow its exact registration pattern); add `/swarm-memory` slash command to `drone-agent/src/plugins/swarm/` (new `slash-swarm-memory.ts` or colocated per file-size limit): `status`, `refresh`, `session-scope off|on`. Handler uses `DroneSlashCommandContext` (`engine`, `logger`); keep response human-readable strings. Runtime suppression: retriever checks `sessionEnabled && config.swarm.memory.enabled`.
- Test: slash command handlers with mock context; session-scope off stops retrieval; status renders last refresh info.

### Phase D — Validation & docs
**S12. Wiki-librarian guidance + project wiki/ADR.** ADR `docs/` per project convention (decisions/ next number — currently 178 → draft 179 `179-swarm-memory-rag-retrieval.md`) capturing locked decisions 1–12; update project wiki index ([[concepts/memory-pipeline]] link-in). Update AGENTS.md "Memory System" stale tool names while in the area (memory__manage/memory__browse — only if trivially safe, else file an insight).

**S13 (FINAL) — Validation sweep, in order:**
1. `pnpm -r run build` (drone-core first ordering handled by workspace)
2. `pnpm -r run typecheck` → zero NEW errors. Pre-existing/out-of-scope diagnostics (do NOT fix here): `drone-beacon/test/coordinator-client.test.ts` (7), `drone-beacon/test/ws-server.test.ts` duplicate `pushFragmentSyncToAllConnected` (2), `drone-coordinator/test/auth.test.ts` `_code` (2).
3. `pnpm -r run test` → all green; new suites pass.
4. `pnpm -r run lint` (prettier will reformat — re-read files after any lint run before further edits).
5. Manual smoke: `--plugin swarm --debug swarm-memory` with a beacon running + seeded wiki; `/swarm-memory status` shows top-K; delete a coordinator page, `POST /wiki/reindex`, confirm removal from next refresh; stop coordinator, reindex, confirm beacon-origin entries survive.

## Validation criteria (all MUST pass before considered done)
- All S1–S12 unit tests pass (`pnpm -r run test`).
- Deletion-tightness tests: coordinator page delete → reindex → vec rows gone; coordinator unreachable → beacon-origin rows reconciled, coordinator-origin rows NEVER wiped; local+coordinator same-id → distinct indexed entries.
- `enabled:false` produces exactly zero network calls from the retriever (assert fetch mock call count = 0) and the fragment renders `false`.
- Fragment render never performs I/O (code-review check + test asserting render is <10ms with a populated cache and no fetch mock activity during render).
- Segment builder: current query is never present in a dropped/trimmed tail (assert first input === currentQuery verbatim for over-budget cases; hash determinism for identical windows).
- LSP: zero new diagnostics project-wide (compare against the 11 known pre-existing errors listed in S13).
- `pnpm -r run lint` passes (prettier reformat acceptable, then re-verify typecheck).
- `POST /wiki/reindex` + `GET /wiki/semantic-search` reachable and correct per route tests; beacon boots with search disabled (provider absent) without crashing (503 contract).
- Config smoke: project `.drone-agent/config.json` with only `swarm.memory.enabled=true` + anchors merges correctly (deepMerge test).

## Key file map (created/modified)
- Created: `drone-beacon/src/wiki-indexer.ts`, `drone-agent/src/plugins/swarm/memory-window.ts`, `drone-agent/src/plugins/swarm/memory-query.ts`, `drone-agent/src/plugins/swarm/memory-retrieval.ts`, `drone-agent/src/plugins/swarm/slash-swarm-memory.ts`
- Modified: `drone-beacon/src/db/init.ts` (tables), `drone-beacon/src/db/search.ts` or new `db/wiki-chunks.ts` (prefer new file — avoid growing search.ts past size limits), `drone-beacon/src/routes/wiki.ts` (semantic-search route + origin tags + write/delete hooks), `drone-beacon/src/index.ts` (timer wiring + reindex route), `drone-core/src/config-types.ts` (`swarm.memory`), `drone-agent/src/plugins/swarm/index.ts` (retriever+fragment+command wiring), `drone-agent/src/plugins/swarm/tools-wiki.ts` (origin-tagged payloads/descriptions), `docs/agents/debug-flag.md` (flag list), new ADR doc, project wiki index entry.