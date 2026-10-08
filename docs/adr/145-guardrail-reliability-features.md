---
tags: [decision, guardrail, reliability, conversation-service]
related:
  [
    concepts/session-management.md,
    flows/tool-call-loop.md,
    entities/Session.md,
    entities/DroneAgentConfig.md,
    decisions/116-safety-trim-estimate-drop-mismatch.md,
    decisions/142-compaction-turn-granularity-fix.md,
    modules/drone-agent.md,
    modules/drone-core.md,
  ]
---

# 145: Guardrail & Reliability Features — Broken-Response Retry, Identical-Call Streak Detection, Assistant-Text-Before-ToolCalls

**Status**: Implemented (2026-08-18)

## Context

LLMs occasionally produce degenerate output or get stuck in loops: empty responses, reasoning-only responses (thinking but no visible text), or repeatedly making the exact same tool call. Without mitigation these pollute the session with useless turns or abort the whole conversation. The conversation service needed built-in guardrails that detect these conditions and retry with progressively stronger hints, then prompt the user at a hard limit.

Three reliability features were designed (commits `d35b300`, `ad10dd1`):

1. **Broken-response retry** — empty / reasoning-only responses are retried without polluting the session.
2. **Identical tool-call streak detection** — repeated identical single-tool-call iterations are nudged, then hard-limited.
3. **Assistant text before tool calls** — when a response has both text and tool calls, the text is emitted before the batch so the TUI shows it immediately.

A code review found the branch didn't typecheck and two plan deliverables were missed; the rework fixed all of that plus several pre-existing test regressions the feature had introduced.

## Decision

### 1. Config: `session.guardrail`

Guardrail thresholds live under `session.guardrail` in config (drone-core types + schema):

```ts
session: {
  guardrail: {
    brokenResponses:        { hintAfter: 2, maxHints: 2 },
    reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
    identicalToolCalls:     { hintAfter: 2, maxHints: 3 },
  },
}
```

- `hintAfter` — number of identical-context retries before injecting a hint.
- `maxHints` — max hint-carrying retries before the hard-limit prompt.

`DroneGuardrailConfig` / `DroneGuardrailThresholdConfig` fields are **optional** to match the TypeBox schema (so users can override only what they care about). The conversation service resolves full defaults via `DEFAULT_GUARDRAIL` + `resolveThreshold()` into a `resolvedGuardrail` object, so callers never null-check.

### 2. Broken-response retry (Feature 1)

A degenerate response has no tool calls and no assistant message. Truly-empty has no reasoning either; reasoning-only has reasoning text but nothing else. Per-tier counters (`emptyResponseCount`, `reasoningOnlyResponseCount`) keep the two independent so a model alternating between them can't conflate thresholds.

The retry ladder:

- **Phase 1** (`tierCount <= hintAfter`): silent retry with identical context; emits a `notice`, no session mutation.
- **Phase 2** (`tierCount < hintAfter + maxHints`): sets the `brokenResponseHintActive` flag; the next loop iteration injects a non-persisted system hint (mirrors the identical-call nudge). Emits a `notice`.
- **Hard limit** (`tierCount >= hintAfter + maxHints`): emits a `notice`, calls `onBrokenResponseLimitReached(label)`; if the host says continue, resets the tier counter + flag and retries; otherwise returns `''`.

> **Why flag-based hint injection rather than a separate `provider.chat()` call?** The initial implementation made a _separate_ provider chat call inside phase 2 to deliver the hint. That silently consumed an extra queued response per hint attempt, so the hard-limit (which depends on total attempt count) never fired within the queued responses — two tests ("returns empty string when broken-response limit reached without callback", "calls onBrokenResponseLimitReached when hard limit is reached") failed. Flag-based injection keeps attempt counting aligned with the actual number of LLM round-trips.

### 3. Identical tool-call streak detection (Feature 2)

When the LLM makes the exact same single tool call (same name + same `JSON.stringify` arguments) repeatedly, a streak counter increments. After `hintAfter` repetitions it sets `identicalCallNudgeActive` (injected on the next LLM call). After `hintAfter + maxHints` total repetitions it calls `onIdenticalToolCallLimitReached(toolName, args, streak)` or throws "Model appears stuck".

**Ordering with the iteration limit** — the iteration-limit check runs **before** the identical-call hard limit, so a repeated tool call that also exceeds `maxToolIterations` trips the depth limit (which the host can prompt on) rather than the "model appears stuck" abort. When the iteration limit is continued, the identical streak is reset too (a fresh run). This fixed the `calls onToolIterationLimitReached and continues` and persona-`toolCallLimit` regressions while preserving the guardrail identical-limit throw.

### 4. Assistant text before tool calls (Feature 3)

When a response includes both text and tool calls, `assistantMessage` / `assistantMessageComplete` are emitted **before** `toolCallBatch`, so the TUI can render the text immediately.

### 5. Reset semantics

All guardrail state (identical streak, per-tier broken-response counters, `identicalCallNudgeActive`, `brokenResponseHintActive`) resets when:

- a new user message enters the loop,
- `conversation.resetStuckDetectors()` is called,
- `conversation.clearSession()` is called.

`resetStuckDetectors` is now exposed to plugins via the `_runtime` capability. `CreateDronePluginEngineOptions` gained an optional `resetStuckDetectors` callback; the engine threads it through and adds it to the `_runtime` capability object; `index.tsx` wires it via a mutable ref (`resetStuckDetectorsRef`) since the conversation is created after the engine.

### 6. Tool-execution pipeline dedup

The Feature-1 hint path previously duplicated the ~100-line tool-execution pipeline (execute → truncate → buffer → stuck-detect → emit → append → hooks → image extraction). Extracted a shared `executeToolCalls()` helper used by both the primary and hint paths, eliminating the duplication.

### 7. Guardrail events use the `notice` kind

Guardrail events emit as `kind: 'notice'`, rendered yellow/italic in the TUI and prefixed with `⚠` in plain-output mode. `DroneConversationEvent` gained the `{ kind: 'notice'; content: string }` variant.

## Key Points

- Guardrail thresholds are configurable per feature under `session.guardrail` with sensible defaults.
- Per-tier counters prevent truly-empty and reasoning-only responses from conflating each other's limits.
- Flag-based hint/nudge injection (not a separate `provider.chat`) keeps attempt counting aligned with actual LLM round-trips — this is the pattern that made the hard-limit tests pass.
- The iteration-limit check precedes the identical-call hard limit so depth limits (which the host can prompt on) win over the "model appears stuck" abort.
- `resetStuckDetectors` is reachable by plugins via the `_runtime` capability.
- The shared `executeToolCalls()` helper removed ~100 lines of duplicated tool-execution logic.
- Validation: `pnpm -r run build`, `pnpm lint`, LSP (zero errors), and the fast test suite all pass (1987 passed / 9 skipped / 0 failed).

## Related

- session-management — Session lifecycle and guardrail reset semantics
- tool-call-loop — Where guardrails hook into the loop
- [Session](../../drone-core/src/session-types.ts) — `DroneConversationEvent` including the `notice` kind
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — `session.guardrail` config section
- [116-safety-trim-estimate-drop-mismatch](116-safety-trim-estimate-drop-mismatch.md) — Stuck detector / safety-trim context
- [142-compaction-turn-granularity-fix](142-compaction-turn-granularity-fix.md) — Turn model the guardrails operate within
- [166-parallel-duplicate-tool-call-dedup](166-parallel-duplicate-tool-call-dedup.md) — Parallel duplicate tool-call dedup guardrail (same `session.guardrail` config)
