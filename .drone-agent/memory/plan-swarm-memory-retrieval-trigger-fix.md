---
key: plan-swarm-memory-retrieval-trigger-fix
tags:
  - swarm
  - swarm-memory
  - rag
  - retrieval
  - plan
  - bug-fix
  - done
created: 2026-09-03T04:05:55.935Z
updated: 2026-09-03T04:13:58.661Z
---

PLAN (COMPLETED 2026-09-03): Fix swarm-memory retrieval trigger ordering. Commit 7008f52.

PROBLEM (root cause): Pipeline intended the CURRENT user message to drive RAG (memory-query.ts). But swarm/index.ts triggered retrieval from onBeforePrompt, which fires BEFORE sendUserMessage. The userMessage conversation event (populates tracker.current.userQuery) is emitted inside sendUserMessage. So currentQuery was always '' at refresh → retrieval ran on the PREVIOUS completed round only (one-turn lag); first message of a session had no prior round → inputs.length===0 → no injection on first prompt.

AGREED SCOPE: remove onBeforePrompt trigger; single trigger = userMessage branch of existing onConversationEvent hook. Engine runs conversation-event hooks fire-and-forget with .catch() (conversation-service.ts:461-466), so refresh can't block the turn. Issue 2 (fire-and-forget races sync fragment cache read) KEPT non-blocking per plan; tested as converged-after-async state. Keep /swarm-memory refresh + createSwarmMemoryFragment unchanged. Fix memory-query.ts "verbatim"→"noise-filtered" doc. Out of scope: synchronous first-render freshness, queue-drain multi-userMessage, non-chat turns.

STEPS COMPLETED:
1) swarm/src/plugins/swarm/index.ts — onConversationEvent now: memoryTracker.onEvent(event); then if(event.kind==='userMessage') void memoryRetriever.maybeRefresh(memoryTracker.assemble()).catch(()=>{}). Removed onBeforePrompt block. DONE.
2) memory-query.ts JSDoc "verbatim"→"noise-filtered". DONE.
3) memory-window.test.ts — no change (ordering semantics already pinned). DONE/verified.
4) NEW test/plugins/swarm/memory-trigger.test.ts — 5 cases PASS: (a) no retrieval before userMessage; (b) userMessage triggers exactly one /wiki/semantic-search, q param = current message; (c) first message after roundComplete still fires non-empty q (empty-first-prompt regression); (d) assistantMessage/toolCall/roundComplete never trigger; (e) async freshness — vi.waitFor searchCalls, retriever cache populated, fragment render includes returned title. DONE.
5) Validation PASSED: pnpm -r build ✓; LSP 0 diag on touched files ✓; eslint ✓; prettier ✓; targeted integration swarm-spawn+coordinator-trust+fragments (30) ✓; full `pnpm test` ✓ (193 files, 2699 passed, 14 skipped). NOTE: `pnpm -r run test` fails in drone-core ("No test files found" — include globs are monorepo-root relative but vitest runs each package's own cwd) — PRE-EXISTING, unrelated to this change. Use root `pnpm test`.
   - Commit also checks in .drone-agent project memory/insights updates.

TESTING GOTCHAS (worth keeping): (1) the swarm plugin registers TWO onConversationEvent hooks (memory-trigger in swarm/index.ts AND buffering in swarm/hooks.ts:293) — a single-slot capture overwrites, so the integration capture must collect ALL hooks into an array and dispatch() them in order (mirrors engine's conversationEventHooks array). (2) URLSearchParams encodes spaces as '+' which decodeURIComponent does NOT handle — extract q via new URL(url).searchParams.get('q'). (3) run vitest from repo root via `npx vitest run <path>` or `pnpm test`, NOT `pnpm -C drone-agent vitest run` (include globs are monorepo-root relative).

VALIDATION CRITERIA: met — zero LSP; build pass; lint pass; all swarm memory tests pass; no regression in swarm-spawn/coordinator-trust/fragments; new test proves userMessage is sole trigger + current message appears as q; proves first-prompt retrieval; onBeforePrompt trigger gone; /swarm-memory + fragment tests pass.

BACKGROUND (pipeline): drone-agent/src/plugins/swarm/: track (memory-window.ts) → build (memory-query.ts buildQueryInputs) → refresh (memory-retrieval.ts SwarmMemoryRetriever.maybeRefresh hash-debounced, one GET /wiki/semantic-search?q= per input) → inject (memory-fragment.ts createSwarmMemoryFragment cache-only). Merge=per-doc max score; minScore 0.35; topK 5; anchors boost. Config swarm.memory.{enabled,topK,minScore,window.maxQueryTokens(6000)/maxQuerySegments(3),anchors}.