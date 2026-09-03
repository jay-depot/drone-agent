---
key: plan-swarm-memory-retrieval-trigger-fix
tags:
  - swarm
  - swarm-memory
  - rag
  - retrieval
  - plan
  - bug-fix
created: 2026-09-03T04:05:55.935Z
updated: 2026-09-03T04:05:55.935Z
---

PLAN: Fix swarm-memory retrieval trigger ordering.

PROBLEM: Pipeline intended the CURRENT user message to drive RAG (memory-query.ts:36-40 "current query verbatim first never truncated"), but swarm/index.ts triggers retrieval from onBeforePrompt (lines 180-183), which fires BEFORE sendUserMessage. The userMessage conversation event (which populates tracker.current.userQuery, memory-window.ts:94-95) is emitted inside sendUserMessage (conversation-service.ts:461). So currentQuery is always '' at refresh → retrieval runs on the PREVIOUS completed round only (one-turn lag); first message of a session has no prior round → inputs.length===0 → no injection on first prompt. Also memory-query.ts:38-40 comment claims "verbatim" but code pushes filterForQuery(currentQuery).

AGREED SCOPE (validated with user):
- Remove onBeforePrompt retrieval trigger; single trigger = userMessage branch of the existing onConversationEvent hook (swarm/index.ts:175-183). Engine already runs conversation-event hooks fire-and-forget with .catch() (conversation-service.ts:461-466), so refresh can't block the turn.
- Issue 2 (fire-and-forget races sync fragment cache read): KEEP non-blocking, NO blocking refactor. Just test/assert fresh entries appear once async refresh resolves (converged state).
- Keep /swarm-memory refresh manual override + createSwarmMemoryFragment (cache-only) unchanged.
- Fix memory-query.ts comment "verbatim"→"noise-filtered".
- Out of scope: synchronous first-render freshness, queue-drain multi-userMessage per turn (pre-existing), non-chat turns no longer trigger retrieval (chat-rounds-only by design).

STEPS:
1) swarm/src/plugins/swarm/index.ts — new onConversationEvent: memoryTracker.onEvent(event); then if(event.kind==='userMessage') void memoryRetriever.maybeRefresh(memoryTracker.assemble()).catch(()=>{}). Delete onBeforePrompt block.
2) memory-query.ts JSDoc "verbatim" → "noise-filtered" (no behavior change).
3) memory-window.test.ts no change — verify ordering semantics already pinned (keeps in-flight round as current; steering lands in list).
4) NEW test/plugins/swarm/memory-trigger.test.ts — follow swarm-spawn.test.ts pattern (mockFetchWithBeaconRegistration, capture registration incl hooks.onConversationEvent, enable swarm.memory in getConfig). Cases: (a) no retrieval before userMessage; (b) userMessage triggers exactly one /wiki/semantic-search, last req q contains the current message text; (c) first message with prior roundComplete still fires non-empty q (empty-first-prompt regression); (d) assistantMessage/toolCall/roundComplete never trigger; (e) async freshness — after flush microtasks, retriever.getCache() populated and fragment render includes returned title. May need capture-helper refactor (local copy in new file preferred over touching swarm-spawn.test.ts unless non-breaking).
5) Validate: pnpm -r build, pnpm -r lint, targeted vitest run test/plugins/swarm/ + swarm-spawn + swarm-coordinator-trust, pnpm -r test; LSP zero diagnostics.

VALIDATION CRITERIA: zero LSP; build pass; lint pass; all swarm memory tests pass; no regression in swarm-spawn/coordinator-trust; new test proves userMessage is sole trigger + current message appears as q; proves first-prompt retrieval; onBeforePrompt trigger gone; /swarm-memory + fragment still pass.

BACKGROUND (pipeline): drone-agent/src/plugins/swarm/: track (memory-window.ts) → build (memory-query.ts buildQueryInputs) → refresh (memory-retrieval.ts SwarmMemoryRetriever.maybeRefresh hash-debounced, one GET /wiki/semantic-search?q= per input) → inject (memory-fragment.ts createSwarmMemoryFragment cache-only). Merge=per-doc max score; minScore 0.35; topK 5; anchors boost. Config swarm.memory.{enabled,topK,minScore,window.maxQueryTokens(6000)/maxQuerySegments(3),anchors}.