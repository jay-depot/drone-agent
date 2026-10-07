---
tags: [decision, swarm, session-import, slash-command, transcript, coordinator]
related: [concepts/session-management.md, concepts/session-processing-pipeline.md, modules/drone-coordinator.md, modules/drone-agent.md, modules/drone-core.md, modules/drone-agent-plugins.md, entities/DroneAgentConfig.md, decisions/135-compaction-slash-command.md, decisions/142-compaction-turn-granularity-fix.md, decisions/116-safety-trim-estimate-drop-mismatch.md]
---

# 146: Swarm Session Import — `/swarm-session` command + coordinator transcript endpoint

**Status**: Implemented (2026-08-18); refined by a review-fix batch (2026-08-19) — session reads now proxy through the beacon, `llm` is an optional dep, `--from N` resume added, list shows `updatedAt`, transcript blob resolution parallelized.

## Context

Session restoration in other AI agent platforms recreates an old session as a *continuation*. drone-agent's swarm model wanted something different: an **import** that recreates the context of an old swarm session into the current session. Two properties distinguish it from a continuation:

1. **Importable at any stage** — it can run mid-session, not just as a resume. (The most common case is picking up an old session in the first turn.)
2. **Not a continuation** — it does not try to recreate the exact compaction summaries. It's an import, not a resume.

The natural mechanism (confirmed with the user) is to summarize the old session with a clean LLM and inject the summary as additional context, with messages explaining what it is. The design was deliberately open to "variations on the usual themes" as an experiment.

## Decision

### Entry point: `/swarm-session` slash command

A slash command (not a workflow — workflows are startup-only) with subcommands:

```
/swarm-session list [--limit N] [--status S]
/swarm-session import <sessionId> [--from N]
```

- `list` queries the coordinator `GET /api/sessions`, **filters out the current session**, and prints a compact table (id, persona, status, createdAt, updatedAt). Default limit 10, all statuses. No interactive picker (deferred as a future idea).
- `import` fetches the transcript, splits it into up to `maxChunks` chronological slices, summarizes each, and injects them.
- `--from N` is a 1-indexed **stateless resume** point: if a chunk fails to summarize mid-import, the import aborts and prints which chunks were imported plus a `--from N` resume command. Because chunking is deterministic, re-running with `--from N` skips the already-imported chunks and resumes from the failed one. Out-of-range `--from` is rejected.

### Session reads proxy through the beacon (not the coordinator directly)

The agent never talks to the coordinator directly for session reads. It hits **beacon proxy routes** (`drone-beacon/src/routes/sessions.ts`): `GET /sessions?limit=&status=` and `GET /sessions/:id/transcript`. The beacon forwards to the coordinator via its typed, trust-gated `CoordinatorClient.getSessionTranscript` (and the existing `getSessions`). The beacon is the sole coordinator-facing trust gate; the agent's command takes the beacon `baseUrl`, not a `coordinatorUrl`. Transcript building stays in the coordinator — the beacon is a pure pass-through (503 when no coordinator or it's unreachable).

### Transcript conversion lives in the coordinator

The coordinator converts a session's raw `swarm_events` into a lightweight transcript, exposed via a dedicated `GET /api/sessions/:id/transcript` endpoint (`drone-coordinator/src/transcript.ts`). This is shared with the **swarm memory pipeline** — both consumers get the same transcript rather than the agent re-deriving it. The transcript mirrors compaction's `formatTurnsForSummary` shape:

```
# Session <id>
persona: <persona>
beacon: <beacon>
status: <status>
created: <iso>
updated: <iso>

--- Turn 1 ---
[user] ...
[assistant] ...
  tool_call: file__read({"path":"a.ts"})
(tool=file__read) <result>
```

- Events grouped into turns by `correlationId` (one user-prompt round per turn), falling back to a new turn per event.
- **Noise events filtered** (compaction notices, reasoning, progress, completion markers, non-batch tool events).
- **Tool results truncated** to a bounded length (400 chars) — but tool calls + truncated results are KEPT (the summarizer decides what to discard, per its prompt).
- Blob payloads (>10KB) are resolved back to content.

### Injection model: each chunk = its own unprotected synthetic tool-call/result turn

Following the `/skills recall` precedent (append to conversation as a synthetic tool result), each imported chunk is injected as a **synthetic `session_import` tool-call/result pair**:

```ts
sessionManager.appendAssistantMessage('', [{ id, name: 'session_import', arguments: { sessionId, chunk, totalChunks } }]);
sessionManager.appendToolResult('session_import', summary, id);
```

- **Each chunk is its own turn** (because `appendAssistantMessage` creates a new turn) — giving safety-trim **per-chunk degradability** (oldest chunks dropped first as the session grows). This is the key reason for one-turn-per-chunk rather than collapsing all chunks into one turn.
- **Unprotected** (not `kind: 'summary'`) — the imported context is subject to safety-trim and compaction like any ordinary content, so it can't accumulate forever (also future-proofs agent-directed recall). No new session-manager primitive was needed — it reuses the existing `appendAssistantMessage` + `appendToolResult` pair.
- Synthetic calls to a non-existent tool are harmless: the conversation service only dispatches tool calls from the current LLM response, never from history; provider adapters serialize them fine.

### Summarization: a new prompt (process + results), token budget from context window

The import summarizer uses a **different** system prompt than compaction. Compaction prioritizes user requests + results; session import prioritizes **process and results** — what was done, how, in what order, and the tools/actions — because the goal is to resume work, not just recall outcomes.

- **Chunking**: split the transcript into up to `maxChunks` contiguous chronological slices. Each slice is summarized with the clean LLM (`getActiveProvider().chat({ tools: [] })`, no tool loop).
- **Per-chunk token budget** = `chunkTokenBudgetPercent` (default 12) of the resolved context window — so **larger models get more detailed summaries**.
- **Compaction fires between chunks** (`onAfterToolCall` runs after each chunk), so compaction can reclaim space and minimize safety-trim risk.

### Config: `swarm.sessionImport`

```
"swarm": { "sessionImport": { "maxChunks": 5, "chunkTokenBudgetPercent": 12 } }
```

- `maxChunks` (default 5) — max slices.
- `chunkTokenBudgetPercent` (default 12) — per-chunk budget as % of context window.
- **No `enabled` flag** — it's a slash command, you use it or you don't.
- Fields optional to match `Partial<DroneSwarmConfig>`; `DroneSessionImportConfig` exported from drone-core; added to the `swarm` deepMerge spec.

### Self-import guard + current-session filtering

- `import` rejects importing the **current session** into itself.
- `list` filters the current session out of results.

### TUI wiring fix (a bonus)

The slash-command context's `sessionManager` subset only exposed `appendUserMessage` + `appendToolResult`. The import command needs `appendAssistantMessage`, so it was added to the subset in `drone-core`, wired in `interactive.ts`, and — importantly — the TUI was passing `sessionManager: undefined` to slash commands. `DroneTuiOptions` gained a `sessionManager` field, `index.tsx` passes it into `createTui`, and `tui/app.tsx` wires it. This also **fixed a pre-existing gap** where `/skills recall`/`/skills create` got no session manager in the TUI.

## Key Points

- `/swarm-session` is an **import**, not a continuation — it summarizes the old session with a clean LLM rather than replaying exact compaction summaries.
- The transcript conversion lives in the **coordinator** (`GET /api/sessions/:id/transcript`), shared with the swarm memory pipeline.
- Each chunk is injected as its own **unprotected** synthetic tool-call/result turn, giving safety-trim per-chunk degradability (oldest dropped first).
- A dedicated **process + results** summary prompt (vs. compaction's requests + results) reflects that the goal is resuming work.
- Per-chunk token budget scales with the resolved context window → larger models get more detailed summaries.
- Compaction fires between chunks (`onAfterToolCall`) to keep the import under the safety-trim budget.
- Fixing the TUI's missing `sessionManager` in slash-command dispatch also unblocked `/skills recall`/`create` in the TUI.
- Validation: LSP zero errors, `pnpm -r run build`/`typecheck`/`lint` clean, fast suite 2013 passed / 9 skipped.

## Related

- session-management — Turn model the import operates within (per-turn safety-trim)
- session-processing-pipeline — Swarm session lifecycle (the import consumes ended/processed sessions)
- [drone-coordinator](../../drone-coordinator/) — Transcript endpoint
- [drone-agent](../../drone-agent/) — TUI wiring + session import
- [drone-core](../../drone-core/) — `swarm.sessionImport` config + `appendAssistantMessage` subset
- [drone-agent-plugins](../../drone-agent/src/plugins/) — swarm plugin `/swarm-session` command
- [135-compaction-slash-command](135-compaction-slash-command.md) — The `/compact` command / CompactionCapability model this resembles
- [142-compaction-turn-granularity-fix](142-compaction-turn-granularity-fix.md) — Why per-turn granularity matters for safety-trim/compaction
