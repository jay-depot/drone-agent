---
tags: [decision, swarm, memory, rag, wiki, semantic-search, beacon, prompt-fragments, embeddings]
related: [concepts/memory-pipeline.md, concepts/semantic-search.md, modules/drone-beacon.md, modules/drone-agent-plugins.md, concepts/swarm-prompt-fragments.md, decisions/151-memory-pipeline-infra.md, decisions/173-swarm-prompt-fragments.md, decisions/164-model-role-bindings.md]
---

# 179: Swarm Memory RAG — query-aware wiki injection (selection & retrieval)

**Status**: Implemented (2026-08-31, branch `feat/swarm-memory-rag`)

## Context

The memory pipeline ([[decisions/151-memory-pipeline-infra]]) covers the WRITE
side of swarm memory: ended sessions are distilled by the wiki-librarian into
wiki pages on the coordinator (and beacon-local pages). The READ side did not
exist — wiki content reached an agent only when the agent explicitly called
`wiki_search` (naive keyword substring) or `wiki_read`. Nothing surfaced
relevant wiki knowledge proactively.

This feature adds the selection & retrieval side of swarm memory RAG: each
agent session can get a compact, query-aware index of relevant wiki entries
injected into its system prompt, with on-demand recall. The agent embeds
nothing; the hub owns the vector index over the merged wiki corpus.

## Decision

**1. Beacon-side wiki vector index.** New dedicated tables on the beacon
(`wiki_sources`, `wiki_chunks`, `wiki_vec_chunks` vec0 FLOAT[768] cosine) hold
chunks of the **merged** wiki corpus — beacon-local pages AND coordinator
pages — indexed distinctly as `(page_id, origin)`. Same embedding stack as
workspace search (Ollama `nomic-embed-text:v1.5`, `search_document:` /
`search_query:` prefixes). Coordinators are unchanged; beacons fetch
coordinator pages via the existing mTLS wiki proxy.

**2. Deletion tightness (hard requirement).** Index reconciliation is
set-difference against the authoritative page set. A failed/unreachable
coordinator fetch is NEVER an authoritative empty set: `runWikiIndexCycle`
narrows reconciliation to beacon-origin rows when the coordinator page list
cannot be fetched, so coordinator-origin rows are never wiped by a hub blip.
Local wiki PUT/DELETE hooks trigger a fire-and-forget reindex; a 5-minute
sweep is the backstop; `POST /wiki/reindex` is the manual entry point.

**3. Query-aware, agent-initiated retrieval.** No server→agent push plumbing.
The agent tracks conversation events (`onConversationEvent`) to maintain the
tight window — [previous round's user query + steering + previous round's
final assistant response + current round's query]. **Updated 2026-09-03
([[decisions/184-swarm-memory-retrieval-trigger-fix]]): the refresh trigger
moved from `onBeforePrompt` to the `userMessage` branch of `onConversationEvent`**
— `onBeforePrompt` fired before `sendUserMessage` (the call that emits the
`userMessage` event), so the current query was never present at refresh time
(one-turn lag + nothing on a session's first message). Now the current user
message always drives retrieval. A sha256 of the final assembled query inputs
debounces work (identical windows re-run nothing). The current query is ALWAYS
the first input, never truncated (Ollama truncates from the END of over-long
inputs, which would silently drop the newest text). Over-budget windows are
segmented via the prose chunker (`chunkText`), keeping the most recent fitting
segments under `window.maxQueryTokens` (6000, client-side; server-side
truncation is banned by design) with a `maxQuerySegments` (3) cap; every input
embeds separately and results merge by per-document MAX score, then additive
configurable anchor boosts (`swarm.memory.anchors`).

**4. Injection = advertise + recall.** A `# Swarm Memory (wiki)` header
fragment lists top-K entries as one-liners — `title · pageId (origin) ·
score — one-line pitch` — with a framing header (reference data from past
sessions, not instructions) and recall instructions pointing at
`swarm__wiki_read` (the canonical tool; **updated 2026-09-03**). The pitch is
the best-matching chunk excerpt trimmed to ~240 chars; no LLM pitch calls. The
fragment reads the retriever's cache ONLY (never the network at render time)
and returns `false` while disabled/empty/pre-refresh.

**5. Stateless beacon route.** `GET /wiki/semantic-search?q&maxResults&minScore&origin`
(overfetch ×4, per-`(pageId,origin)` max-score grouping, metadata
enrichment, 503 without an embedding provider) is the beacon's only new
surface. It is NOT gated by the agent-side flag — it is generally useful
wiki semantic search. `swarm.memory` config (`DroneSwarmMemoryConfig`,
default `enabled: false`) governs only the agent's proactive injection.

**6. Origin honesty on recall.** `GET /wiki/:pageId` without `?scope=` now
returns ALL versions of the id (`{ pageId, versions[] }`), each tagged with
its origin; `?scope=beacon|coordinator` keeps single-fetch semantics;
list/keyword-search payloads carry `origin` tags. An id existing on both
sides yields two distinctly indexed/retrievable entries; the fragment line
carries the origin so recall picks the right scope.

**7. Control surface.** `--debug swarm-memory` logs refreshes (hash, input
count, entry count) and failures. `/swarm-memory` gives `status`, `refresh`
(hash-bypassing forced refresh), and `session-scope off|on` runtime
suppression without config edits. **Updated 2026-09-03**: each real retrieval
also emits a `[swarm.memory: found N matches]` chat-log notice via
`_runtime.emitEvent({kind:'notice'})` for human oversight (see
[[decisions/184-swarm-memory-retrieval-trigger-fix]]). No mid-panel widget
(declined for v1).

**8. Security posture.** Wiki pages are LLM-authored from session logs, so
proactive injection is a prompt-injection surface. Accepted for the
single-user swarm: the pitch is low-potency data (score + excerpt), the
fragment header frames everything as reference data not instructions, the
full-body path was already available via wiki tools, and `/swarm-memory
status` + `--debug swarm-memory` give human oversight. No sanitization layer
in v1. A cross-project provenance filter is a future extension (trivial via
the origin column).

**9. Distiller seam designed, not built.** An LLM preprocessing step
(`llm.modelRoles.distiller` per [[decisions/164-model-role-bindings]]) is an
explicit future extension point in the pipeline
(WindowFilter → QueryBuilder → embed/merge). Default off; measure first
(granite-3b-class). v1 ships deterministic two-channel behavior: current
query + token-budgeted, segmented window input.

## Config

`swarm.memory` (deep-merged like sessionImport): `enabled` (default **false**
— v1 opt-in), `topK` (5), `minScore` (0.35), `anchors`
(`tags`/`boostPerTag` 0.08/`boostTitle` 0.05), `window`
(`maxQueryTokens` 6000 / `maxQuerySegments` 3). Disabled ⇒ fragment hidden
AND zero network calls.

## Alternatives considered

- **Coordinator-side vector index** — index at the source; rejected: new
  vector infra + Ollama dependency on the global hub, query-latency through
  the beacon proxy, and a second installation to maintain. The beacon index
  reuses every existing primitive.
- **Hub-push via swarm fragments channel** — beacon embeds/ranks and pushes
  a targeted fragment; rejected: that channel is engineered for durable
  human-authored content (TTL, coordinator mirroring, CLI); per-round
  machine churn there adds moving parts with no staleness benefit over
  agent-inline retrieval.
- **Full-page injection / LLM-written pitches** — rejected for prompt-budget
  and latency reasons; advertise+recall with chunk-derived pitches won.
- **LLM query distillation** — designed as the seam, deferred pending
  measurement (ADR 164 model-role pattern, e.g. a granite-3b-class role).

## Consequences

- Wiki knowledge becomes proactive: agents get relevant entries without
  knowing the wiki exists. Recall instructions keep bodies on demand.
- The wiki corpus gains a vector index for the first time; wiki deletion is
  now index-tight with tests (delete → reconcile → chunks gone; coordinator
  down → no wipe; same-id → distinct per-origin entries).
- Retrieval is fire-and-forget and asynchronous, so the first LLM call of a
  turn may still show the prior cache; the current message drives the refresh
  and entries converge to the current topic as it resolves (see
  [[decisions/184-swarm-memory-retrieval-trigger-fix]] for the trigger fix
  that made the current message the primary query).
- `drone-agent` gains a `drone-swarm-common` dependency (chunk primitives).
- Beacon `routes/wiki.ts` moved off `drone-swarm-common/wiki-storage` static
  imports where dynamic-import resolution failed under vitest (subpath
  specifiers unresolvable in the test runner) to the root package specifier.
