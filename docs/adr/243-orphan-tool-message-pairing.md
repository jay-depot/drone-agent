---
tags: [openrouter, llm, openai-driver, tool-calls, message-integrity, adr]
related:
  [
    decisions/242-openrouter-error-body-consumed-by-tool-routing-retry.md,
    decisions/146-swarm-session-import.md,
    modules/drone-agent-plugins.md,
    modules/drone-agent.md,
    concepts/session-management.md,
  ]
---

# Orphan tool messages: pair synthetic tool results and coerce stragglers at the wire

**Summary**: With OpenRouter active, running `/skills recall <id>` (directly or inside a macro) made **every subsequent message** fail with `400 messages[N]: tool messages must include a non-empty string tool_call_id`. The recall handler appended a bare `role:'tool'` session message (`ctx.sessionManager.appendToolResult('skills__recall', raw)`) with **no `tool_call_id` and no preceding assistant tool-call** — an orphan. It persists in the session and is re-sent on every later request; the OpenAI-family serializer (`shared/openai-compatible.ts`) omits `tool_call_id` when the message has none, so OpenRouter's strict OpenAI-compat validation rejected it forever. Only OpenRouter broke: the anthropic adapter injects a fallback id and the echo driver rewrites `tool`→`user`. Fix: (1) the recall site now appends a **paired** synthetic assistant tool-call + matching tool result via a shared `appendSyntheticToolExchange` helper (the `session-import` precedent, now shared); (2) a presentation-only seam (`coerceOrphanToolMessages`, called as the first step of `prepareRequestMessages`) coerces any remaining orphan `tool` message to a `user` message before it crosses the wire — content preserved, stored session untouched.

## Context

`/skills recall` injects the loaded skill body into the conversation so the model sees the instructions. The mechanism is a synthetic tool result appended to the session:

```ts
// drone-agent/src/plugins/skills/index.ts (pre-fix)
ctx.sessionManager?.appendToolResult('skills__recall', raw);
```

`appendToolResult` appends to the current turn. With no `toolCallId` argument and no preceding assistant message declaring a `skills__recall` tool-call, the resulting `role:'tool'` message is an **orphan**. It is stored in the session and included in every subsequent request assembly (`conversation-service.ts` flattens `[...systemMessages, ...sessionManager.getMessages(), ...footerMessages]`).

The OpenAI-family wire serializer then omits the id:

```ts
// drone-agent/src/shared/openai-compatible.ts
if (msg.toolCallId) {
  base.tool_call_id = msg.toolCallId;
}
```

OpenRouter validates strictly and rejects the request with `400 ... tool messages must include a non-empty string tool_call_id`. Because the orphan is stored once and never removed, the failure is permanent for the rest of the session. Macros reproduce it identically: the macro handler re-dispatches `/skills recall` with its own `DroneSlashCommandContext`, which carries `sessionManager` in both the TUI and readline hosts.

**Why only OpenRouter.** The anthropic adapter synthesizes a fallback id (`tool_use_id: message.toolCallId ?? \`call_${random}\``), the echo driver rewrites `tool`messages to`role:'user'`, and the vanilla OpenAI plugin is not in use. OpenRouter is the only active provider that enforces the id requirement hard.

**Existing correct precedent.** `swarm/session-import.ts`'s `injectChunk` already appended the correct shape — an assistant message carrying a synthetic tool-call (with an id) immediately followed by the tool result with the matching id. `/skills recall` was the only producer that skipped the assistant half (verified by sweeping every `appendToolResult` call site in `drone-agent/src`).

## Decision

1. **Pair synthetic tool results (root-cause fix).** A new shared helper `drone-agent/src/shared/synthetic-tool-exchange.ts` — `appendSyntheticToolExchange(sessionManager, { toolName, toolCallId, arguments, content })` — appends the assistant tool-call and its matching tool result as one pair, so both halves carry the same id. Both producers use it: `/skills recall` (now `toolCallId: \`skills-recall-${randomUUID()}\``) and `session-import`'s `injectChunk` (migrated; behavior byte-identical — same id format and arguments object).
2. **Coerce orphans at the wire (defensive seam).** A pure helper `drone-agent/src/shared/tool-message-integrity.ts` — `coerceOrphanToolMessages(messages)` — returns a new array in which any `role:'tool'` message whose `toolCallId` is empty **or** matches no _preceding_ assistant tool-call id is coerced to `role:'user'` (content preserved). It runs as the first step of `prepareRequestMessages` (`conversation-service.ts`), the single chokepoint both LLM send sites already use — the main tool loop and the `/btw` aside. The stored session is never mutated; this is presentation-only.
3. **Narrow detection.** Only the orphan-`tool` direction is repaired; a dangling assistant `tool_calls` entry with no matching result is left alone (pairing holds elsewhere — an assistant call and its results share a session turn, so safety-trim drops them atomically).

## Rationale

- **Both fixes, not one.** Fixing only the append site (A) leaves the whole class of failure — any future append that forgets an id produces a _permanent_ 400 — unguarded. Fixing only the seam (B) hides a malformed append instead of correcting it. The project's own precedent (ADR 242) is to fix the real thing; a cheap guard is worth adding because the failure mode is total.
- **Paired exchange over append-as-user (A1 over A2).** A `user` turn would change semantics and surface in the TUI scrollback as user input. The paired tool exchange preserves the intended "tool result" shape and reuses the existing, proven precedent.
- **Paired exchange over synthesize-id-only (A1 over A3).** A lone tool message with an invented id is still orphan (no preceding assistant tool-call) and is rejected by the same validators.
- **Coerce over drop (B1 over B2).** The whole point of recall is to load instructions into context; dropping the orphan would silently discard the skill body. A `user` turn is valid on every provider (the echo driver already relies on this).
- **Coerce over pair-repair (B1 over B3).** Pair-repair would insert a synthetic assistant tool-call at the seam, making the presentation layer more complex and order-sensitive. Coercion is a single, local, content-preserving transform.
- **A single chokepoint.** Placing the call inside `prepareRequestMessages` covers both send sites without duplicating the invocation, and keeps the "derive wire representation" contract in one function.

## Implementation

- `drone-agent/src/shared/synthetic-tool-exchange.ts` — new: `appendSyntheticToolExchange`.
- `drone-agent/src/plugins/skills/index.ts` — `/skills recall` appends via the helper with a `randomUUID`-based id; drops the bare `appendToolResult`.
- `drone-agent/src/plugins/swarm/session-import.ts` — `injectChunk` delegates to the helper.
- `drone-agent/src/shared/tool-message-integrity.ts` — new: `coerceOrphanToolMessages`.
- `drone-agent/src/runtime/conversation-service.ts` — `prepareRequestMessages` coerces orphans first.

No drone-core, config, schema, storage, compaction, or adapter changes.

## Tests

- `drone-agent/test/synthetic-tool-exchange.test.ts` — the helper appends exactly two messages; the assistant half carries a tool-call with the given id; the tool half carries the matching id; arguments default to `{}`.
- `drone-agent/test/tool-message-integrity.test.ts` — valid pair unchanged; no-id → `user`; unmatched-id → `user`; matching call positioned _after_ the tool message → coerced (preceding-match, not global); non-tool/empty passthrough; input not mutated.
- `drone-agent/test/conversation-service-image-describer.test.ts` — end-to-end seam test: a session seeded with an orphan tool message produces an outbound request with no id-less tool message (verified failing pre-fix and passing post-fix).
- `drone-agent/test/skills-plugin.test.ts` — `/skills recall <id>` appends a paired assistant `skills__recall` tool-call (non-empty id) immediately followed by the matching tool result, and `coerceOrphanToolMessages` leaves it untouched (verified failing pre-fix and passing post-fix).

## Key Points

- **A synthetic tool result is only valid with its assistant tool-call half.** Appending a bare `role:'tool'` message creates a permanent wire-invalid session — the failure repeats on every later request, not just once.
- **Strict OpenAI-compat providers expose latent message-integrity bugs.** Providers with lenient adapters (anthropic fallback id, echo tool→user rewrite) hide the malformed shape; OpenRouter validates hard.
- **Reuse the existing correct shape.** `session-import` already did it right; extracting the shared helper prevents the next producer from re-introducing the orphan.
- **Repair at the presentation seam, not in storage.** The coercion keeps stored history, scrollback, compaction, and logs untouched and works for every provider via one chokepoint.

## Related

- [242-openrouter-error-body-consumed-by-tool-routing-retry](242-openrouter-error-body-consumed-by-tool-routing-retry.md) — the fix that made this 400's real body visible (the same OpenRouter error path)
- [146-swarm-session-import](146-swarm-session-import.md) — the paired synthetic `session_import` tool-call/result precedent this generalizes
- [160-unified-llm-error-retry-semantics](160-unified-llm-error-retry-semantics.md) — the `DroneLlmError` / retry contract this request never reached
