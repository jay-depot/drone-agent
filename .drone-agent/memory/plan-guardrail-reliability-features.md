---
key: plan-guardrail-reliability-features
tags:
  - plan
  - guardrail
  - reliability
  - conversation-service
created: 2026-08-17T21:19:39.487Z
updated: 2026-08-17T21:19:39.487Z
---

# Plan: Guardrail & Reliability Features (retry broken responses, identical-tool-call nudge, show assistant text with tool calls)

## Summary

Three reliability/guardrail features in the drone-agent conversation loop (`drone-agent/src/runtime/conversation-service.ts`):

1. **Retry "broken" LLM responses** — a response with no tool calls and no assistant message is retried (tiered: truly-empty vs reasoning-only), with a non-persisted hint escalation, then a user prompt at the hard limit.
2. **Identical tool-call nudge** — detect a degenerate loop where the model emits the same single tool call (name+params) repeatedly; nudge at threshold, prompt user at higher threshold. Distinct from the existing fail-chain detector.
3. **Show assistant text when it accompanies tool calls** — currently the text is added to context but never displayed in the TUI.

## Key files

- `drone-agent/src/runtime/conversation-service.ts` (704 lines) — the tool-call loop in `sendUserMessage` (lines 300-630). Reasoning emit at 387-390. Tool-call branch at 391+. Empty/assistant-only branch at 621-627. `ConversationService` type at 33-60. `CreateConversationServiceOptions` at 62-97.
- `drone-agent/src/index.tsx` — wires `createConversationService` (line 167), `onToolIterationLimitReached` (178-198), `onStuckErrorThresholdReached` (199-216). `_runtime` capability set in engine.initialize().
- `drone-agent/src/runtime/plugin-engine.ts` — `_runtime` capability (line 770), `getCapability` (865), `request('runtime')` special-case (541-543).
- `drone-core/src/session-types.ts` — `DroneChatMessage` (49-56), `DroneConversationEvent` (135-167), `DroneChatResponse` (84-89).
- `drone-core/src/config-types.ts` — `session` config (defaults at 470-485).
- `drone-core/src/config-schema.ts` — `session` schema (lines 145-152).
- `drone-agent/src/tui/app.tsx` — event switch (186-430), assistantMessage handling (330-377), toolCallBatch (238-283).
- `drone-agent/src/output-handlers.ts` — plain/NDJSON event handlers.
- Tests: `drone-agent/test/conversation-service.test.ts`, `drone-agent/test/conversation-service-events.test.ts`.

## Config (uniform `{ hintAfter, maxHints }` shape under `session`)

```ts
session: {
  brokenResponses: { hintAfter: 2, maxHints: 2 },
  reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
  identicalToolCalls: { hintAfter: 2, maxHints: 3 },
}
```

- `hintAfter` = retries with identical context before injecting the non-persisted hint.
- `maxHints` = retries with the hint before the hard-limit user prompt.
- All three trigger the "continue or stop" elicitation prompt at their hard limit in the TUI. Non-interactive modes (NDJSON/--once) fall through to current behavior (return empty / let loop end) — no prompt.

## New event kind

`{ kind: 'notice', content: string }` added to `DroneConversationEvent`. Rendered by TUI as a single dim/italic line. NDJSON/plain consumers render or ignore. (Compaction refactor to use `notice` deferred to later scope.)

## Feature 1 — Retry broken responses

- In the non-tool-call branch (621-627), detect degenerate: no `message` and no `toolCalls`. Two tiers: truly-empty (no reasoning) vs reasoning-only (has reasoning).
- Retry with IDENTICAL context up to `hintAfter` times (do NOT append the degenerate response to the session — avoids polluting context).
- Then inject a non-persisted system-role hint at the END of the messages sent to the LLM, retry up to `maxHints` more times. Hint is NOT persisted to the session.
- Emit a `notice` marker into the stream indicating a degenerate response and its type (e.g. "degenerate response (empty), retrying" / "degenerate response (reasoning-only), retrying").
- On hard limit: invoke a new `onBrokenResponseLimitReached` callback (wired in index.tsx to elicit "continue or stop"); if it returns true, reset and continue; else fall through to current behavior (return empty string).
- Reasoning deferral: move the reasoning emit (387-390) so it only fires for a KEPT response. Degenerate responses show no reasoning, just the marker.

## Feature 2 — Identical tool-call nudge

- New detector in the tool-call branch. Streak advances only when a response contains EXACTLY ONE tool call identical (name + params) to the previous response's single call. Any different call, multiple calls, or no calls resets the streak. A user turn resets it.
- At `hintAfter` (2): inject a non-persisted system-role nudge at the end of context. Nudge does NOT reset the counter.
- At `maxHints` (3): invoke a new `onIdenticalToolCallLimitReached` callback (wired in index.tsx to elicit "continue or stop"); if true, reset streak and continue; else throw/abort.
- `resetStuckDetectors()` API on `ConversationService` resets BOTH the identical-call streak AND the fail-chain stuck counter. Exposed to plugins via the `_runtime` capability (wired in index.tsx after engine.initialize()).

## Feature 3 — Show assistant text with tool calls

- In the tool-call branch (411-427), emit `assistantMessage`/`assistantMessageComplete` BEFORE `toolCallBatch` so the text commits above the tool calls. Text is already appended to context (line 412-415); this just surfaces it in the TUI.

## Implementation steps

1. **drone-core config types** (`config-types.ts`): add `brokenResponses`, `reasoningOnlyResponses`, `identicalToolCalls` to `session` config type + defaults.
2. **drone-core config schema** (`config-schema.ts`): add the three nested objects to the `session` schema.
3. **drone-core event type** (`session-types.ts`): add `{ kind: 'notice'; content: string }` to `DroneConversationEvent`.
4. **conversation-service.ts**: add new options to `CreateConversationServiceOptions` (thresholds, `onBrokenResponseLimitReached`, `onIdenticalToolCallLimitReached`); add `resetStuckDetectors` to `ConversationService`; implement Feature 1 (retry loop + hint + notice + reasoning deferral), Feature 2 (streak detector + nudge + prompt), Feature 3 (emit assistantMessage before toolCallBatch).
5. **index.tsx**: wire the two new callbacks (elicit "continue or stop"); expose `resetStuckDetectors` via `_runtime` capability.
6. **TUI** (`app.tsx`): handle `notice` event (dim/italic single line).
7. **output-handlers.ts**: handle `notice` (render or ignore).
8. **Tests**: add unit tests in `conversation-service.test.ts` (retry tiers, hint injection non-persistence, streak detection/reset, notice emission, assistantMessage-before-toolCallBatch ordering, resetStuckDetectors) and `conversation-service-events.test.ts` (event ordering). Config schema tests.
9. **Docs**: update AGENTS.md if needed; add wiki decision page.

## Validation criteria

- LSP passes (typescript) with zero errors.
- `pnpm -r run lint` passes (eslint + prettier).
- `pnpm -r run build` passes.
- `pnpm -r run test` (fast suite) passes, including new tests.
- New code covered by unit tests.
- No dead code / unused vars / fluff comments.
- Files under 1000 lines (conversation-service.ts is 704 — watch growth; consider splitting if it exceeds 1000).
