---
key: plan-swarm-session-import
tags:
  - plan
  - swarm
  - session-import
  - slash-command
  - transcript
  - coordinator
  - completed
created: 2026-08-18T21:45:06.475Z
updated: 2026-08-18T22:11:20.309Z
---

# Plan: Swarm-Based Session Import (`/swarm-session`)

## Summary

Add a `/swarm-session` slash command (subcommands `list` and `import`) that recreates the context of an old swarm session into the current session. Unlike session restoration in other platforms, this is an *import* (not a continuation): it can run at any stage of the current session (most commonly the first turn), and it does NOT try to recreate exact compaction summaries. Instead it fetches the old session's transcript from the coordinator, summarizes it in chunks with a clean LLM using a NEW summary prompt (prioritizing process+results, vs. compaction's requests+results), and injects each chunk as a synthetic `session_import` tool-call/result pair — each chunk its own turn, tail-inserted, unprotected (subject to safety-trim/compaction), with compaction given a chance to fire between chunks. The transcript conversion lives in the coordinator (shared with the swarm memory pipeline).

## Key architecture facts

- Coordinator `swarm_sessions` + `swarm_events` tables hold the conversation log. `GET /api/sessions/:id/log` returns `{ session, events }` with blob payloads (>10KB) resolved. Each event's `payload` is a JSON-serialized `DroneConversationEvent`; events carry `correlationId` grouping one user-prompt round.
- Beacon `coordinator-client.ts` has UNUSED `getSessions`/`getSessionLog`/`processSession`/`completeSessionProcessing` methods (lines 864-951) wrapping the coordinator endpoints.
- Coordinator seeded personas (`coordinator-wiki-librarian`, `coordinator-admin` in `drone-coordinator/src/index.ts:569-629`) reference `session_list`/`session_get_log`/`session_mark_processed` tools that are NOT implemented anywhere — a pre-existing gap.
- Session manager (`drone-agent/src/runtime/session-manager.ts`): `appendAssistantMessage(content, toolCalls)` creates a NEW turn; `appendToolResult(name, content, toolCallId)` appends to the current turn. `prependSystemTurn(content, {kind:'summary'})` prepends a protected summary turn. `getTurns()` returns copies (no direct push). Safety-trim drops turns per-turn (all-or-nothing per turn), oldest non-summary first, skipping `kind:'summary'`.
- Clean LLM path: `registration.request<DroneLlmCapability>('llm')` → `getActiveProvider().chat({ model, messages, tools: [] })`. Requires declaring `{ id: 'llm' }` in plugin metadata dependencies. Compaction demonstrates this.
- Tool-result safety limit: `config.session.maxToolResultTokensPercent` default 15% of context window (`conversation-service.ts:496-501`). `truncateToolResult` enforces per result.
- Compaction fires on `onBeforePrompt` + `onAfterToolCall` hooks; `runCompaction` does a cheap budget check and returns early when under soft threshold. `/skills create` demonstrates manually calling `runHooks('onBeforePrompt')`/`runHooks('onAfterToolCall')` around long work.
- Slash-command context `sessionManager` subset (`drone-core/src/plugin-system.ts:330-336`) exposes only `appendUserMessage` + `appendToolResult`. `interactive.ts:395-400` wires it; `tui/app.tsx:502` passes `sessionManager: undefined` (TUI gap — `/skills recall`/`/skills create` don't get a session manager in TUI today).
- TUI `DroneTuiOptions` (`drone-agent/src/tui/types.ts:105`) has NO `sessionManager` field; `createTui` at `index.tsx:420` doesn't pass it.
- Synthetic tool-call/result pairs against non-existent tools are safe: conversation service only dispatches tool calls from the current LLM response, never history; provider adapters (`toOpenAiMessage`, `toAnthropicMessage`) serialize them fine with fallback `call_...` ids; persona list-mount precedent exists.
- Config: `DroneSwarmConfig` (`drone-core/src/config-types.ts:218-230`) has `knowledgeSync`; defaults at line 560. Merge spec at line 440: `swarm: { deepMerge: { knowledgeSync: {} } }`.
- Coordinator routes registered in `drone-coordinator/src/routes/index.ts` under `/api` prefix; `swarm.ts` holds session routes. Tests use `buildTestApp` (app-helper.ts) + `setupDb`/`teardownDb` (test/setup.ts).

## Design decisions (locked with user)

- Command: `/swarm-session` with subcommands `list` and `import` (NOT `/import`).
- `/swarm-session list [--limit N] [--status S]`: query coordinator `GET /api/sessions`, filter out current session, print compact table (id, persona, status, createdAt/updatedAt). Default limit 10, all statuses. Plain listing (no interactive picker — future idea).
- `/swarm-session import <sessionId>`: fetch transcript, split into up to `maxChunks` (default 5) chronological slices, summarize each with clean LLM to a per-chunk token budget = `chunkTokenBudgetPercent` (default 12) of resolved context window (so larger models → more detailed summaries), inject each as synthetic `session_import` tool-call/result pair (own turn, tail, unprotected), run `onAfterToolCall` between chunks so compaction can fire. Self-import guard: reject importing current session id.
- Transcript conversion lives in the COORDINATOR (shared with swarm memory pipeline), exposed via dedicated `GET /api/sessions/:id/transcript` endpoint (NOT bolted onto /log or /process).
- Transcript format: mirror compaction's `formatTurnsForSummary` shape (`--- Turn N ---` + `[role] content` + `tool_call: name(args)` + `(tool=name) content`). Group by `correlationId` into turns (fallback: new turn per event). Filter noise events (compaction, notice, toolProgress, reasoning, reasoningComplete, assistantMessageComplete, non-batch toolCall/toolResult). Truncate tool results to a few hundred chars. Include session metadata header (id, persona, beacon, timestamps). KEEP tool calls + truncated results (the summarizer decides what to discard per its prompt).
- New summary prompt for import (vs. compaction): prioritize PROCESS and RESULTS (what was done, how, steps), with requests included where they fit. Compaction stays requests+results.
- Config: `swarm.sessionImport` with `maxChunks` + `chunkTokenBudgetPercent` (NO `enabled` flag — it's a slash command, you use it or you don't).
- Each chunk = its own turn via synthetic tool-call/result pair (reuses existing `appendAssistantMessage` + `appendToolResult`; no new session-manager primitive needed).

## Phases

### Phase 1: Coordinator transcript endpoint
- `drone-coordinator/src/transcript.ts` (new): `buildSessionTranscript(session, events)` — resolve blob payloads, parse event JSON, group by correlationId, filter noise, truncate tool results, render `--- Turn N ---` lines, prepend metadata header. Pure function, unit-testable.
- `drone-coordinator/src/routes/swarm.ts`: add `GET /sessions/:id/transcript` → 404 if session missing, else `{ session, transcript }`.
- Tests in `drone-coordinator/test/routes/swarm.test.ts` (transcript endpoint) + a unit test for `buildSessionTranscript` (noise filtering, correlationId grouping, truncation, metadata header).

### Phase 2: Config types + defaults
- `drone-core/src/config-types.ts`: add `DroneSessionImportConfig = { maxChunks: number; chunkTokenBudgetPercent: number }`; add `sessionImport: DroneSessionImportConfig` to `DroneSwarmConfig`; add to defaults (`maxChunks: 5`, `chunkTokenBudgetPercent: 12`); add `sessionImport: {}` to the `swarm` deepMerge spec.
- Rebuild drone-core (`pnpm build`) before dependent typecheck.

### Phase 3: Swarm plugin — transcript fetch + summarizer
- `drone-agent/src/plugins/swarm/`:
  - `session-import.ts` (new): `fetchTranscript(coordinatorUrl, sessionId)`, `splitTranscriptIntoChunks(transcript, maxChunks)`, `summarizeChunk(provider, model, chunk, tokenBudget)` using a NEW `IMPORT_SUMMARY_SYSTEM_PROMPT` (process+results priority), `injectChunk(sessionManager, chunk, sessionId, index, total)` building the synthetic `session_import` tool-call/result pair.
  - `tools-session.ts` (new): `createSessionListTool(coordinatorUrl, currentSessionId)` + `createSessionImportTool(...)` OR implement as slash-command handlers directly. (Recommend: implement list/import as slash-command handlers in a new `session-command.ts`, reusing `coordinatorFetch`/`handleCoordinatorResponse` from `tools-coordinator.ts`.)
- `drone-agent/src/plugins/swarm/index.ts`: add `{ id: 'llm' }` to metadata dependencies; `request<DroneLlmCapability>('llm')`; register `/swarm-session` slash command; read `swarm.sessionImport` config.
- Slash-command handler needs `ctx.sessionManager.appendAssistantMessage` — add to the `sessionManager` subset in `drone-core/src/plugin-system.ts` (append `appendAssistantMessage`).

### Phase 4: Wire session manager into slash-command contexts
- `drone-core/src/plugin-system.ts`: add `appendAssistantMessage` to `DroneSlashCommandContext.sessionManager` subset.
- `drone-agent/src/interactive.ts:395-400`: add `appendAssistantMessage` to the wired subset.
- `drone-agent/src/tui/types.ts`: add `sessionManager` to `DroneTuiOptions` (subset with `appendUserMessage`, `appendAssistantMessage`, `appendToolResult`).
- `drone-agent/src/index.tsx:420`: pass `sessionManager` into `createTui`.
- `drone-agent/src/tui/app.tsx:502`: replace `sessionManager: undefined` with the wired subset.
- This ALSO fixes the pre-existing TUI gap where `/skills recall`/`/skills create` get no session manager.

### Phase 5: Tests
- Swarm plugin: unit tests for transcript fetch, chunk splitting, summarizer prompt, synthetic injection (asserts each chunk is its own turn via `getTurns()`), self-import guard, list filtering of current session.
- Slash-command context wiring: assert `appendAssistantMessage` present in interactive + TUI contexts.
- Coordinator: transcript endpoint + `buildSessionTranscript` unit tests.

### Phase 6: Docs + validation
- Update `docs/agents/swarm-plugin.md` (or new `docs/agents/session-import.md`) with the command, transcript format, config.
- Update wiki pages (swarm-architecture, session-management, swarm-console-command-spec if relevant).
- Validation: LSP zero errors; `pnpm -r run lint` + `pnpm -r run build` + `pnpm -r run typecheck` zero errors; fast test suite passes; manual smoke (list shows sessions excluding current; import injects chunks as separate turns; compaction fires between chunks).

## Deferred (explicitly)
- Interactive picker for session selection (future idea).
- Agent-directed recall (mentioned as unlikely future).
- Implementing the `session_list`/`session_get_log`/`session_mark_processed` tools referenced by seeded personas (separate concern; the transcript endpoint is a prerequisite but the tools themselves are out of scope).

## Validation criteria
- LSP passes (typescript, yaml, json, dockerfile, css, html) with zero errors.
- `pnpm -r run lint`, `pnpm -r run build`, `pnpm -r run typecheck` all pass with zero errors.
- Fast test suite (`pnpm -r run test`) passes.
- New code covered by unit tests (transcript builder, chunk splitter, summarizer, injection, self-import guard, list filtering, context wiring).
- Manual smoke: `/swarm-session list` excludes current session; `/swarm-session import <id>` injects N chunks as N separate turns; compaction fires between chunks; larger model → more detailed summary.

## COMPLETED 2026-08-18 (commit a29f2ba on feat/swarm-session-import)

All phases implemented and validated. Summary of what was done:

- **Phase 1**: `drone-coordinator/src/transcript.ts` (`buildSessionTranscript`) + `GET /sessions/:id/transcript` route in `swarm.ts`. Tests: `test/transcript.test.ts` (7 tests) + 2 endpoint tests in `test/routes/swarm.test.ts`.
- **Phase 2**: `DroneSessionImportConfig` in `config-types.ts` (fields optional to match `Partial<DroneSwarmConfig>`), `sessionImport` on `DroneSwarmConfig`, defaults (`maxChunks:5`, `chunkTokenBudgetPercent:12`), deepMerge spec, config-schema entry, exported from drone-core index. Config tests added to `drone-agent/test/config.test.ts`.
- **Phase 3**: `session-import.ts` (fetchTranscript, splitTranscriptIntoChunks, summarizeChunk with IMPORT_SUMMARY_SYSTEM_PROMPT, injectChunk) + `session-command.ts` (createSwarmSessionCommand with list/import handlers). Swarm plugin registers the command, adds `{id:'llm'}` dependency, reads `swarm.sessionImport` config.
- **Phase 4**: Added `appendAssistantMessage` to `DroneSlashCommandContext.sessionManager` subset (drone-core), wired in `interactive.ts`, added `sessionManager` to `DroneTuiOptions`, passed in `index.tsx` createTui, used in `tui/app.tsx` (replacing `undefined`). Fixed the pre-existing TUI gap. Updated 4 TUI test files with sessionManager stubs.
- **Phase 5**: `test/session-import.test.ts` (11 tests incl. per-turn injection via real session manager) + `test/session-command.test.ts` (4 tests: list filtering, self-import guard, unknown subcommand, missing id).
- **Phase 6**: `docs/agents/session-import.md` + AGENTS.md reference. Validation: LSP zero errors on all changed files; `pnpm lint`/`pnpm build`/`pnpm typecheck`/`pnpm test` all pass (2013 tests, 9 skipped LSP smoke).

### Implementation notes / deviations
- `injectChunk` takes a minimal `SessionImportSessionManager` subset type (not the full `DroneSessionManager`) since slash-command contexts only expose the subset.
- `session-command.ts` has a `normalizeConfig` helper applying defaults when config fields are absent (config fields are optional).
- The `SwarmConfig` plugin type does NOT have `sessionImport`; the command reads `registration.getConfig().swarm.sessionImport` (which has defaults applied) instead.
- Manual smoke against a live coordinator was NOT run (requires provisioned swarm); unit tests cover the behaviors instead.
- The plan memory file itself was committed (per AGENTS.md, .drone-agent contents are checked in intentionally).