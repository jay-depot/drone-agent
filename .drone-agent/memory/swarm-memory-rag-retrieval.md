---
key: swarm-memory-rag-retrieval
tags:
  - swarm
  - swarm-memory
  - rag
  - semantic-search
  - retrieval
  - bug
  - review
created: 2026-09-03T03:52:26.403Z
updated: 2026-09-03T03:57:05.197Z
---

How user messages become RAG queries. Pipeline in drone-agent/src/plugins/swarm/: track (memory-window.ts ConversationWindowTracker) → build (memory-query.ts buildQueryInputs) → refresh (memory-retrieval.ts SwarmMemoryRetriever) → inject (memory-fragment.ts). Wired in swarm/index.ts:209-231.

FLOW: Tracker groups userMessage/assistantMessage/roundComplete into rounds; first userMessage→userQuery, mid-round→steering[], assistantMessage→lastResponse. assemble()→WindowParts{currentQuery,prevUserQuery,prevSteering[],prevResponse}. onBeforePrompt hook (swarm/index.ts:224-227) calls maybeRefresh(assemble()) fire-and-forget. buildQueryInputs: currentQuery+window through filterForQuery (strips code fences/braces/absolute paths/hex/symbol-dense runs), current query pushed first (inputs[0]) then token-budgeted window (default 6000), sha256 debounce hash. maybeRefresh hash-debounced, fires ONE GET /wiki/semantic-search?q=<input> per input in parallel (retrieve:196-211). Fragment (memory-fragment.ts) reads cache ONLY, renders # Swarm Memory (wiki) header. Merge = per-doc MAX score across inputs; configurable anchor boosts; top-K (default 5), minScore 0.35.

REVIEW FINDINGS (2026-09-03):

- **MAIN BUG: current user message never becomes a query at refresh time.** onBeforePrompt fires BEFORE sendUserMessage. Entrypoints: tui/app.tsx:585-586 & interactive.ts:261-263 run onBeforePrompt then sendUserMessage. The userMessage CONVERSATION EVENT (which sets tracker.current.userQuery) is only emitted inside sendUserMessage (conversation-service.ts:461, 440/461). After previous roundComplete, current=null (memory-window.ts:91-95). So at maybeRefresh(assemble()) time currentQuery is ALWAYS ''. Retrieval runs on the PREVIOUS completed round only → one-turn lag. First message of a session: no prev round → inputs.length===0 → maybeRefresh returns empty cache (memory-retrieval.ts:147) → NO injection on first prompt. Fix: trigger refresh from the userMessage event (onConversationEvent, swarm/index.ts:215-218) instead of onBeforePrompt, so tracker.current.userQuery is populated before buildQueryInputs.
- Minor: buildQueryInputs pushes filterForQuery(currentQuery) but comment says "verbatim, never truncated" (memory-query.ts:38-40) — noise-stripped, not verbatim. Doc overstatement.
- Fire-and-forget refresh (swarm/index.ts:222) races synchronous cache read in fragment render (memory-fragment.ts:30); renders previous cycle's cache when hash changed.
- Verified FINE: segmentation loop (chunkText search-chunker.ts:7 uses tokens*4, estimateTextTokens token-estimate.ts:11 uses len/4 ceil — consistent; kept.length>0 guard fine); server prefixes match (wiki-indexer.ts:170 search_document:, wiki.ts:231 search_query:); merge/boost/cache sane; isEnabled() guard correct.

Config: swarm.memory.{enabled,topK(5),minScore(0.35),window.maxQueryTokens(6000)/maxQuerySegments(3),anchors{tags,boostPerTag(0.08),boostTitle(0)}}. /swarm-memory slash command; --debug swarm-memory logs hashes.
