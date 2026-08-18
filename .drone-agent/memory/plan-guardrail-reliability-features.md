---
key: plan-guardrail-reliability-features
tags:
  - plan
  - guardrail
  - reliability
  - conversation-service
  - completed
created: 2026-08-17T21:19:39.487Z
updated: 2026-08-18T03:13:28.655Z
---

# Plan: Guardrail & Reliability Features — COMPLETED

## Summary

All three guardrail features have been implemented and committed on branch `feat/guardrail-reliability-features` (commit `d35b300`).

### Features Implemented

1. **Retry broken LLM responses** — Empty or reasoning-only responses are retried with tiered hints before prompting user
2. **Identical tool-call streak detection** — Detects degenerate single-tool-call loops, nudges, then prompts user
3. **Show assistant text with tool calls** — `assistantMessage`/`assistantMessageComplete` events now emit before `toolCallBatch`

### Files Changed

- `drone-core/src/config-types.ts`: Added `DroneGuardrailConfig`, `DroneGuardrailThresholdConfig` types, `guardrail` field on `DroneSessionConfig`, defaults in `createDefaultAgentConfig`, deep-merge spec
- `drone-core/src/config-schema.ts`: Added `GuardrailThresholdSchema`, `GuardrailSchema`, wired into session
- `drone-core/src/session-types.ts`: Added `{ kind: 'notice'; content: string }` to `DroneConversationEvent`
- `drone-core/src/index.ts`: Exported new types
- `drone-agent/src/runtime/conversation-service.ts`: All three features implemented with state tracking, hint/nudge injection, callbacks, `resetStuckDetectors()`
- `drone-agent/src/index.tsx`: Wired `onBrokenResponseLimitReached` and `onIdenticalToolCallLimitReached` callbacks
- `drone-agent/src/tui/theme.tsx`: Added `notice` color property
- `drone-agent/src/tui/types.ts`: Added `'notice'` to `ChatEntry['kind']`
- `drone-agent/src/tui/components/ChatLog.tsx`: Added `case 'notice'` rendering (yellow italic)
- `drone-agent/src/tui/app.tsx`: Added `case 'notice'` event handler
- `drone-agent/src/output-handlers.ts`: Added `case 'notice'` (⚠ prefix)
- `drone-agent/test/conversation-service-guardrails.test.ts`: New test file
- `AGENTS.md`: Added guardrail system documentation

### Config (under `session.guardrail`)

```ts
brokenResponses: { hintAfter: 2, maxHints: 2 },
reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
identicalToolCalls: { hintAfter: 2, maxHints: 3 },
```

### Remaining Work

- Build verification (`pnpm -r run build`, `pnpm -r run lint`, `pnpm -r run test`) requires terminal access
- The test file needs drone-core to be rebuilt for type resolution