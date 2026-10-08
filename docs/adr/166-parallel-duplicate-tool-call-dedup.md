---
tags: [decision, guardrail, reliability, conversation-service]
related:
  [
    concepts/session-management.md,
    flows/tool-call-loop.md,
    decisions/145-guardrail-reliability-features.md,
    decisions/163-tui-markdown-color-collision-fix.md,
  ]
---

# 166: Parallel Duplicate Tool-Call Dedup Guardrail

**Status**: Implemented (2026-08-27)

## Context

LLMs occasionally degenerate into a loop that keeps emitting tool-call tokens, producing a single response containing a **massive batch of parallel identical tool calls** (same tool name + same arguments). Without mitigation these duplicate calls all execute, polluting the session and wasting context and runtime. The existing **identical-call streak** guardrail only tracked identical _single_ tool calls across _iterations_ (`toolCalls.length === 1`); it was blind to a batch of parallel duplicates within one response.

## Decision

Add a new `session.guardrail.deduplicateToolCalls` guardrail that collapses parallel identical tool calls **within a single response** down to the first occurrence of each group, before any further processing. It is a **semantically lossless** transform — one call does what N would.

### 1. Config: a plain on/off toggle (not a threshold ladder)

Reuses the `session.guardrail` **location** but **not** the `{ hintAfter, maxHints }` shape used by the other guardrails. This guardrail is a simple boolean:

```ts
guardrail: {
  brokenResponses:        { hintAfter: 2, maxHints: 2 },
  reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
  identicalToolCalls:     { hintAfter: 2, maxHints: 3 },
  deduplicateToolCalls:   { enabled: true },   // default on
}
```

New type `DroneToolCallDedupConfig = { enabled?: boolean }` (schema: `Type.Object({ enabled: Type.Optional(Type.Boolean()) })`). `createDefaultAgentConfig` defaults it to `true`.

> **Why not a threshold shape?** The other guardrails are threshold ladders (N retries → hint → hard limit). Dedup is a transformation that should apply the moment two identical parallel calls appear — there is no reason to ever run a duplicate. A boolean is more honest than forcing the ladder shape, and users don't have to remember a second config shape.

### 2. Single identity definition — `toolCallSignature`

The identity of "same tool call" is `name + ':' + JSON.stringify(arguments)`, matching exactly the existing identical-call streak guardrail's notion. This is factored into a shared pure helper `toolCallSignature()` in a new `runtime/tool-call-utils.ts` module (alongside `turn-utils.ts`), and the streak guardrail's previously-inlined comparison is refactored onto it — so tool-call identity lives in exactly one place for future tightening (e.g. canonical key ordering to fix false negatives).

### 3. `deduplicateToolCalls()` pure transform

Also in `tool-call-utils.ts`: `deduplicateToolCalls(toolCalls)` preserves order, keeps the first occurrence per signature, and returns `{ deduped, collapsedGroups }` where each collapsed group reports `{ name, removed }` (removed = count − 1, only groups with duplicates). It does **not** mutate the input, and identity ignores the `id` field (the kept call retains its own id).

### 4. Placement — dedup first, before everything else

Runs immediately after `const toolCalls = response.toolCalls ?? []`, **before** broken-response detection. The deduped list flows through to `appendAssistantMessage`, the `toolCallBatch` event, and `executeToolCalls` — so no phantom calls appear in the session or TUI. Because dedup runs before the streak detection, a collapsed batch becomes an ordinary single call that the cross-iteration streak guardrail then tracks normally — the two compose naturally.

### 5. Trigger and observability

Any batch with ≥2 identical calls is collapsed, gated only by `enabled` (no minimum-count). One `kind: 'notice'` is emitted **per collapsed group** (chatty but legible, and reveals whether dedup ever collapses more than one group):

```
Deduplicated 2 identical parallel tool call(s) to 1 (file__read)
```

### 6. Stateless

Dedup has no cross-iteration counters, so it needs no reset wiring in `resetStuckDetectors()` or `clearSession()`.

## Key Points

- New guardrail collapses parallel identical tool calls within one response to the first occurrence — semantically lossless.
- Config is a plain `enabled` toggle (default `true`) under `session.guardrail`, reusing the location but not the threshold shape.
- `toolCallSignature` (in `runtime/tool-call-utils.ts`) is the single definition of tool-call identity, shared by the dedup guardrail and the refactored identical-call streak guardrail.
- Dedup runs first in the loop, so session, execution, and TUI all see only the surviving calls; a collapsed batch composes naturally with the cross-iteration streak guardrail.
- One `notice` per collapsed group signals context health.
- Stateless — no reset wiring.
- Validation: `pnpm -r run build`, `pnpm lint`, LSP (zero errors), and the fast test suite all pass.

## Related

- session-management — Session lifecycle and guardrail reset semantics
- tool-call-loop — Where the guardrail hooks into the loop
- [145-guardrail-reliability-features](145-guardrail-reliability-features.md) — The original guardrail reliability features and `session.guardrail` config
- [Session](../../drone-core/src/session-types.ts) — `DroneToolCall` and `DroneConversationEvent` (the `notice` kind)
