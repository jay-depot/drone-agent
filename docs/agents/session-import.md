# Swarm Session Import

The `swarm` plugin provides a `/swarm-session` slash command for recreating the context of an old swarm session into the current session. This is an **import**, not a continuation: it can run at any stage of the current session (most commonly the first turn), and it does not try to recreate exact compaction summaries.

## Command

```
/swarm-session list [--limit N] [--status S]
/swarm-session import <sessionId> [--from N]
```

### `/swarm-session list`

Lists recent swarm sessions from the coordinator, **excluding the current session**. Defaults to 10 sessions across all statuses. Each line shows `id`, `persona`, `status`, `createdAt`, and `updatedAt`.

- `--limit N` — number of sessions to show (default 10)
- `--status S` — filter by status (`active`, `stale`, `ended`, `processing`, `processed`, `archived`)

### `/swarm-session import <sessionId>`

Fetches the old session's transcript from the coordinator, splits it into up to `maxChunks` chronological slices, summarizes each slice with the clean LLM, and injects each summary into the current session as a synthetic `session_import` tool-call/result pair.

Key behaviors:

- **Each chunk is its own turn**, tail-inserted, and unprotected — so as the current session grows, safety-trim drops the oldest imported chunks first, and compaction can re-summarize them like any other content.
- **Compaction fires between chunks** (`onAfterToolCall` runs after each chunk), so the imported context stays under the safety-trim budget as much as possible.
- **Self-import guard**: importing the current session into itself is rejected.
- **`--from N` stateless resume**: if a chunk fails to summarize mid-import, the import aborts and prints which chunks were imported plus a `--from N` resume command. Because chunking is deterministic, re-running with `--from N` skips the already-imported chunks and resumes from the failed one. If `N` is out of range the import is rejected.
- **Larger models get more detailed summaries**: the per-chunk token budget is a percentage of the resolved context window.

## Transcript format

The coordinator exposes a dedicated `GET /api/sessions/:id/transcript` endpoint that converts a session's raw events into a lightweight transcript. The format mirrors compaction's `formatTurnsForSummary` shape:

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
(tool=file__read) <result content>
```

- Events are grouped into turns by `correlationId` (one user-prompt round per turn), falling back to a new turn per event when absent.
- Noise events (compaction notices, reasoning, progress, completion markers, non-batch tool events) are filtered out.
- Tool results are truncated to a bounded length.
- The transcript is shared by the session-import feature and the swarm memory pipeline.

## Summary prompt

The import summarizer uses a **different** system prompt than compaction. Compaction prioritizes user requests + results; session import prioritizes **process and results** — what was done, how, and the steps — because the goal is to resume work, not just recall outcomes.

## Config

```json
{
  "swarm": {
    "sessionImport": {
      "maxChunks": 5,
      "chunkTokenBudgetPercent": 12
    }
  }
}
```

| Setting                   | Default | Purpose                                                               |
| ------------------------- | ------- | --------------------------------------------------------------------- |
| `maxChunks`               | 5       | Maximum number of chunks the imported session is split into           |
| `chunkTokenBudgetPercent` | 12      | Per-chunk token budget as a percentage of the resolved context window |

There is no `enabled` flag — it's a slash command, you use it or you don't.
