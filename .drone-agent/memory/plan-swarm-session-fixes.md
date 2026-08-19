---
key: plan-swarm-session-fixes
tags:
  - plan
  - swarm
  - session-import
  - refactor
created: 2026-08-19T00:46:04.262Z
updated: 2026-08-19T00:46:04.262Z
---

# Plan: Fix review findings on the `/swarm-session` feature

## Summary

Address seven issues found while reviewing the `feat/swarm-session-import` branch (the `/swarm-session list` + `import` feature). The overarching theme of item #1 is reworking the agent to proxy session data through the beacon (instead of talking to the coordinator directly), which also changes the command's URL source. The remaining items are smaller correctness, robustness, and consistency fixes.

## Items

### Item 1 — Proxy session data through the beacon (LOCKED)
- Rework the session-import path so the AGENT never talks directly to the coordinator; it proxies through the beacon, as everything else does.
- Transcript building STAYS in the coordinator (the existing `GET /api/sessions/:id/transcript` endpoint). The beacon just forwards raw JSON.
- `coordinatorUrl` direct usage by the session feature goes away.
- **Beacon changes:**
  - New `drone-beacon/src/routes/sessions.ts` (new file; `sync.ts` stays the push path):
    - `GET /sessions?limit=&status=` → `client.getSessions(query)` → returns `{ sessions, count }`
    - `GET /sessions/:id/transcript` → `client.getSessionTranscript(id)` → returns `{ session, transcript }`
  - Register in `drone-beacon/src/routes/index.ts`.
  - `CoordinatorClient` (coordinator-client.ts): add typed `getSessionTranscript(sessionId)` method, trust-gated like `getSessionLog`, calls coordinator `/api/sessions/:id/transcript`.
- **Agent changes:**
  - `createSwarmSessionCommand` currently takes `coordinatorUrl`; change to take the beacon `baseUrl` (from `SwarmContext`/`ctx.baseUrl`).
  - `handleList` calls `${baseUrl}/sessions?...`; `fetchTranscript` calls `${baseUrl}/sessions/:id/transcript`.
  - Response shapes unchanged (agent still reads `data.sessions` / `data.transcript`); only the URL source changes.
- **Note for later (OUT OF SCOPE for this branch):** the pre-existing direct-coordinator tools in `tools-coordinator.ts` (spawn, list beacons, list agents, terminate spawn) still hit `coordinatorUrl` directly — they should also be proxied through the beacon in a later refactor.

### Item 2 — Make `llm` an optional dependency of the swarm plugin
- `swarm/index.ts:57` currently declares `{ id: 'llm' }` as REQUIRED. The plugin engine throws at enable time if a required dependency is disabled, which means the entire swarm plugin fails to load — even for `/swarm-session list` (which needs no LLM).
- The `import` handler resolves the LLM via `ctx.engine.getCapability('llm')` (session-command.ts:140), NOT `registration.request('llm')`. `getCapability` is not gated on declared deps, and the handler already guards `if (!llm)`.
- **Fix:** change `{ id: 'llm' }` → `{ id: 'llm', optional: true }`. `list` works without the LLM broker; `import` degrades gracefully via the existing guard.

### Item 3 — Test the import success path
- `session-command.test.ts` only covers error/guard paths; the success path of `handleImport` (chunk loop, per-chunk `runHooks('onAfterToolCall')`, final success log) is untested. The test harness's `getCapability` returns `undefined`, so import bails at the LLM guard.
- **Add tests in `session-command.test.ts`:**
  - Extend `makeContext` to inject a mock `DroneLlmCapability` (getActiveProvider → provider with getContextWindowInfo, getModel → 'model-x').
  - Make `sessionManager` a recording stub (capture `appendAssistantMessage`/`appendToolResult`).
  - `vi.mock('../src/plugins/swarm/session-import.js')`: stub `fetchTranscript` → fixed multi-turn transcript; `splitTranscriptIntoChunks` → N deterministic chunks; `summarizeChunk` → per-chunk deterministic summary; `injectChunk` → real impl against the recording sessionManager.
  - New tests:
    - imports N chunks into N separate turns (assert N assistant+tool pairs / N turns, summarizeChunk called once per chunk).
    - runs `onAfterToolCall` between chunks (assert `runHooks('onAfterToolCall')` called exactly N-1 times, not after the last).
    - warns and bails when the LLM broker is unavailable (`getCapability` → undefined).
    - aborts on summarize failure mid-loop (`summarizeChunk` throws on chunk 2 of 3 → warn "Failed to summarize chunk 2", return true, no chunk 3 injection, no throw).
  - Fold in item 1 change: pass `baseUrl` not `coordinatorUrl`; assert fetch URLs are `${baseUrl}/sessions...` and `${baseUrl}/sessions/:id/transcript` (verifies proxying end-to-end).

### Item 4 — Interface duplication (3 copies of the sessionManager subset shape)
- Three structurally-identical-but-unrelated definitions of the slash-command sessionManager subset:
  1. `DroneSlashCommandContext.sessionManager` (drone-core/plugin-system.ts:363-371) — uses `DroneToolCall[]`.
  2. `SessionImportSessionManager` (drone-agent/src/plugins/swarm/session-import.ts:7-17) — hand-rolled toolCalls shape.
  3. `DroneTuiOptions.sessionManager` (drone-agent/src/tui/types.ts:146-160) — same hand-rolled shape.
- Danger: structurally compatible but not type-related; if `DroneToolCall` changes, copies 2/3 drift silently.
- **Fix (Option A):** extract a single named exported type `DroneSlashCommandSessionManager` in `drone-core/src/plugin-system.ts`, use it for `DroneSlashCommandContext.sessionManager`, re-export it; update `session-import.ts` and `tui/types.ts` to reference it. `interactive.ts`/`app.tsx` wiring unchanged (structural typing).

### Item 5 — Sequential blob resolution in the coordinator transcript builder
- `transcript.ts:158-163` serializes `parseEvent`/`resolveBlob` per event with `await` in a for loop. The `/log` endpoint (`swarm.ts:173-182`) already parallelizes with `Promise.all`.
- **Fix:** parallelize the parse loop with `Promise.all(events.map(evt => parseEvent(evt, resolveBlob)))` + filter nulls. `Promise.all` preserves order; grouping assigns turn numbers so transcript order is unchanged. Behavior-neutral latency win.
- **Tests:** existing `transcript.test.ts` passes unchanged. Add a small test asserting all blob events resolve (resolver called for each).

### Item 6 — `handleImport` partial-import on mid-loop failure
- Currently: `summarizeChunk` throw on chunk k → warn "Failed to summarize chunk k" + `return true`, leaving chunks 1..k-1 silently injected, no resume hint, and the success line never fires.
- **Fix (stop + tell user what got in + stateless resume):**
  - Add `--from N` (1-indexed) to `/swarm-session import <sessionId> [--from N]`.
  - Abort message on failure at chunk k: "Failed to summarize chunk k: <err> / Import aborted: imported chunks 1..k-1 of N. Chunks k..N NOT imported. / Resume with: /swarm-session import <sessionId> --from k".
  - Parse `--from` like `handleList`'s `--limit`/`--status`. Validate `1 <= from <= chunks.length` else warn+bail.
  - Loop `startIndex = from - 1`, but keep the original chunk indices for `injectChunk(i, chunks.length)` so synthetic args `{ chunk: i+1, totalChunks: N }` stay correct for the whole import.
  - Adapt log lines (resuming from chunk X; success "Imported chunks <from>..N").
  - Stateless: re-fetch + re-split on resume (deterministic chunking). NO persistence/state.
  - Rationale: a summarize failure is usually provider-wide; abort avoids N-1 doomed calls; `--from` is the escape hatch after the provider is fixed.
  - Tests (fold into item 3): assert the resume hint in the failure message; assert `--from N` skips the first N-1 chunks and `injectChunk` gets original indices.

### Item 7 — List output omits `updatedAt`
- `handleList` (session-command.ts:93-99) prints id, persona, status, createdAt only — omits updatedAt. The plan intended (id, persona, status, createdAt/updatedAt). The doc's list section doesn't enumerate columns (no active doc/code mismatch, but intent was updatedAt).
- **Fix:** add `updatedAt` to the list output (after createdAt), and update `docs/agents/session-import.md` list section to explicitly enumerate the columns (id, persona, status, createdAt, updatedAt) so it can't drift again.
- `updatedAt` is useful: shows when last touched, more actionable than createdAt for deciding what to resume.

## Execution order
1. Item 4 first (type extraction — foundation others reference).
2. Item 1 (beacon proxy + agent URL source change) — touches the command signature used by items 3 and 6.
3. Items 2, 5, 7 (independent small fixes).
4. Items 6 (logic) and 3 (tests, folding in 1 & 6 URL/flag behavior).

## Validation criteria
- LSP passes (typescript, yaml, json, dockerfile, css, html) with zero errors.
- `pnpm -r run lint`, `pnpm -r run build`, `pnpm -r run typecheck` all pass with zero errors.
- Fast test suite (`pnpm -r run test`) passes.
- New tests cover: import success path (N turns, onAfterToolCall between chunks, LLM-guard bail, mid-loop summarize failure with resume hint, `--from` skipping), beacon proxy URLs (list + transcript), blob resolution in transcript builder, and `updatedAt` in list output.
- Manual smoke: `/swarm-session list` shows both timestamps and excludes the current session; `/swarm-session import <id>` injects N chunks as N separate turns; a failed chunk produces the abort + resume message and `--from k` resumes.

## Deferred (explicitly)
- Proxying the pre-existing `tools-coordinator.ts` direct-coordinator tools through the beacon (separate refactor).
