---
tags: [decision, compaction, turn-granularity, session-management]
related:
  [
    concepts/session-management.md,
    decisions/134-compaction-correctness-fix.md,
    decisions/135-compaction-slash-command.md,
    decisions/053-compaction-latch-fix.md,
    entities/Session.md,
  ]
---

# 142: Compaction Turn Granularity Fix — Each Assistant Message Is Its Own Turn

**Status**: Implemented (2026-08-18)

## Context

Compaction never fired during long agentic (tool-call-heavy) rounds. A "turn" (one `DroneSessionTurn` array item) held the entire user→assistant→tool-call chain: `appendUserMessage()` created a new turn, but `appendAssistantMessage()` and `appendToolResult()` **appended to the current turn**. So 1 user prompt + 300 tool iterations = **1 turn**, which failed the `nonSummaryCount < config.minTurnsToCompact` (default 4) gate. The session then hard-dropped via safety trim and died from overfull context.

The root cause predates the `/compact` slash command — the gate shipped in the compaction-correctness commit (`95817ad`). The fix makes every assistant message its own turn so "turn" reflects real work.

## Decision

### 1. Turn model (Option A)

Every `appendAssistantMessage` call creates a **new turn** (via `turns.push(createTurn(...))`); `appendToolResult` still appends to that assistant's turn; `appendUserMessage` unchanged. A round is now `[user] [assistant+tool] [assistant+tool] … [final assistant]`.

This is **purely a granularity change**: `getMessages()` flattens turns in order, so the flat message sequence sent to the LLM is identical. Only compaction slicing and safety-trim drop granularity change — now dropping one tool round at a time instead of the whole request.

### 2. Final reply is its own turn

A natural consequence of #1 — the final no-tool assistant reply is its own turn.

### 3. Ollama user-message workaround (provider-level)

Ollama (unlike other providers) **rejects a chat request with no user message**, even when the context is purely system instructions. After compaction evicts the last user turn, the conversation loop can assemble a user-less context. Fixed in `ollama.ts` `chat()`: when `messages` contains no `user` role, prepend `{ role: 'user', content: '(Continuing from summaries)' }`. This protects ALL callers (conversation loop, MCP server-description, persona wizard) — the other callers already inject a user message, so the conversation loop is the only affected path.

### 4. Branch restructure

Unified the conversation-service tool-call branch: a single `sessionManager.appendAssistantMessage(response.message, toolCalls)` call site. If tool calls exist, run them; else emit `assistantMessage`/`assistantMessageComplete` and return. The iteration-limit check runs **before** the assistant append so a limit hit doesn't leave a dangling turn.

## Key Points

- The bug was invisible to turn-count-based gating because a whole agentic round collapsed into one turn.
- The turn-granularity change is granularity-only — `getMessages()` order is unchanged, so LLM-visible context is identical.
- The Ollama workaround is provider-level defense-in-depth (covers all callers), not a call-site patch.
- Compaction's gate/slicing needed no logic change — it now sees correct counts naturally.

## Related

- session-management — Turn model and compaction triggering
- [134-compaction-correctness-fix](134-compaction-correctness-fix.md) — Prior sliceSize + convergence-loop fix
- [135-compaction-slash-command](135-compaction-slash-command.md) — `/compact` command + extended capability
- [053-compaction-latch-fix](053-compaction-latch-fix.md) — The `compactionInFlight` latch bug
