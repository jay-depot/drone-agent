---
key: plan-compaction-turn-granularity-fix
tags:
  - compaction
  - plan
  - bugfix
  - turn-granularity
  - ollama
created: 2026-08-18T01:43:46.456Z
updated: 2026-08-18T01:43:46.456Z
---

# Plan: Fix Compaction Turn Granularity + Ollama User-Message Workaround + Branch Restructure

## Summary
The compaction plugin never fires during long agentic (tool-call-heavy) rounds because a "turn" (one `DroneSessionTurn` array item) currently holds the entire user→assistant→tool-call chain. `appendUserMessage()` creates a new turn; `appendAssistantMessage()` and `appendToolResult()` append to the CURRENT (last) turn. So 1 user prompt + 300 tool iterations = 1 turn, which fails the `nonSummaryCount < config.minTurnsToCompact` (default 4) gate. The session then hard-drops via safety trim and dies from overfull context. Root cause predates the slash command (gate was in compaction-correctness commit 95817ad9). Fix: make every assistant message its own turn so "turn" reflects real work.

## Confirmed design decisions
1. **Turn model (Option A)** — every `appendAssistantMessage` call creates a NEW turn; `appendToolResult` appends to that assistant's turn; `appendUserMessage` unchanged. A round = `[user] [assistant+tool] [assistant+tool] … [final assistant]`. The flat message sequence sent to the LLM is UNCHANGED (getMessages() flattens in order) — only compaction slicing and safety-trim drop granularity change.
2. **Final reply is its own turn** (natural consequence of #1).
3. **Ollama workaround (provider-level, Option 1)** — in `ollama.ts` `chat()`, if `messages` contains no `user` role, prepend `{ role: 'user', content: '(Continuing from summaries)' }`. Protects all callers (conversation loop after compaction evicts the last user turn, MCP server-description, persona wizard). Other callers already inject a user message, so conversation loop is the only affected path.
4. **Branch restructure — DO NOW** — unify the tool-call branch: always `sessionManager.appendAssistantMessage(response.message, response.toolCalls)`, then if toolCalls run them, else emit assistantMessage/assistantMessageComplete and return. Removes the separate final-reply append call site. Composes cleanly with #1.

## Files to modify
### drone-agent/src/runtime/session-manager.ts
- `appendAssistantMessage`: change from `appendToCurrentTurn(...)` to `turns.push(createTurn({...}))` (always a new turn). `appendToolResult` stays `appendToCurrentTurn` (appends to the assistant's turn). `appendUserMessage` unchanged.

### drone-agent/src/runtime/conversation-service.ts
- Restructure the loop body (lines ~390-632): single `appendAssistantMessage(response.message, response.toolCalls)` call site. If `toolCalls.length > 0`: emit toolCallBatch, run tools, truncate, stuck-detector, appendToolResult batch, onAfterToolCall, image handling, shouldStopLoop check, continue. Else: emit assistantMessage/assistantMessageComplete, return response.message. Keep iteration-limit + onToolIterationLimitReached logic. (Feature-3 from the guardrail memory — assistantMessage emitted before toolCallBatch — is already partly present; preserve it.)

### drone-agent/src/plugins/ollama.ts
- In `chat()`, before `client.chat(...)`, compute `const hasUser = messages.some(m => m.role === 'user'); const outbound = hasUser ? messages.map(toOllamaMessage) : [{ role: 'user' as const, content: '(Continuing from summaries)' }, ...messages.map(toOllamaMessage)];`. Use `outbound` in the call. (Placeholder constant per user decision.)

### drone-agent/src/plugins/compaction/index.ts
- No logic change needed for the gate itself (it now sees correct counts). Verify `nonSummaryCount`/`sliceSize`/`getOldestNonSummaryTurns` still correct with new grouping. `getStatus` turn counts will naturally reflect new granularity.

## Tests to update
- **session-manager.test.ts**: "groups assistant + tool results into the latest user turn" → now each assistant message is its own turn. Expect turns = [user][assistant+tool][assistant]. Update `messages.map(m => m.role)` expectations and turn counts. "starts a new turn when no current turn exists" — simplify comment (appendAssistantMessage now always creates a turn).
- **compaction.test.ts**: rewrite sessions to construct turns the way the real service does (user message then one assistant message per tool round — now the natural granularity). Re-derive `chatMock).toHaveBeenCalledTimes(N)` and exact turn-count literals from corrected semantics. Keep behavioral assertions (usage drops below threshold, oldest compacted first, summaries evicted). Many call sites (lines ~291-1801).
- **conversation-service.test.ts**: verify branch restructure preserves behavior (tool-call loop, iteration limits, stuck detection, provider switch, final reply). Update any assertions that depend on old turn grouping. Add a test: a response with toolCalls then a final no-tool response produces correct turn/message sequence.
- **ollama.test.ts** (if exists) or new: verify chat() injects the placeholder user message when no user role present, and does NOT inject when one exists.

## Validation criteria
- LSP passes (typescript) with zero errors.
- `pnpm -r run lint` passes (eslint + prettier).
- `pnpm -r run build` passes.
- `pnpm -r run test` (fast suite) passes, including updated/new tests.
- New code covered by unit tests.
- No dead code / unused vars / fluff comments. Files under 1000 lines.
- Manual sanity: a long tool-only round (many assistant+tool turns after one user message) now has many turns and compaction fires via onAfterToolCall when usage exceeds threshold; `/compact show` reports realistic nonSummary counts.

## Notes
- No drone-core type changes needed (DroneSessionTurn shape unchanged).
- Turn-granularity change is purely granularity — getMessages() order unchanged.
- Sweep ALL consumers of the turn grouping (compaction, log plugin, safety trim) and their test mocks for stale assumptions (per project principle).