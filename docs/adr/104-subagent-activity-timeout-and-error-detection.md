---
tags: [decision, subagent, timeout, error-handling]
related: [concepts/subagent.md, decisions/080-subagent-dispatch-pretty-output.md]
---

# Decision 104: Subagent Activity-Based Timeout and Error Detection

**Status**: Implemented (commit `aa6182c` on `feat/better-subagent-timeouts`)

## Context

The `subagent__dispatch` tool used a fixed wall-clock timeout (default 5 minutes) that never reset, even when the subagent was actively making progress. This was problematic for coding agent swarm scenarios where subagents sometimes do long jobs. Additionally, two error-handling gaps existed:

1. `error` NDJSON events from subagents were silently dropped by the parent process
2. LLM API errors (e.g., Ollama cloud quota exhaustion) caused the subagent to hang forever without emitting a clean `return` event

## Decision

### Activity-Based Timeout

Replace the fixed wall-clock timeout with an **activity-based timeout** that resets on any NDJSON event from the subagent (reasoning, toolCall, toolResult, assistantMessage, error, return). The `timeout` input parameter now controls this activity timeout.

### Hard Cap

Add a **hard cap of 1 hour** (3,600,000ms) that never resets, preventing runaway subagents even if they keep making progress.

### Error Event Forwarding

`error` NDJSON events from subagents are now forwarded to the parent via `onProgress` with an `error:` prefix. In the close handler, if no `return` event is found, the code falls back to scanning for the last `error` event.

### LLM API Error Handling

`conversation.sendUserMessage()` in `runJsonMode` is now wrapped in try/catch. On error, the subagent emits `{ kind: 'error', message }` then `{ kind: 'return', result: '', error: message }`, then exits with code 1. This prevents subagents from hanging forever when the LLM API fails.

### TUI Rendering

The `SubagentDispatchBlock` component now handles `error:` prefix events, rendering them with error color and `✗` indicator.

## Consequences

- Subagents that are actively making progress will not be killed by the activity timeout
- Subagents that go silent (no NDJSON events) will still be killed after the activity timeout
- No subagent can run longer than 1 hour, regardless of activity
- LLM API errors in subagents produce clean error + return events and exit code 1
- Error events from subagents are visible in the TUI during execution
- The stuck detector (3 consecutive same-tool errors) already works in subagent mode via the existing `onStuckErrorThresholdReached` callback in `index.tsx` (returns `false` in non-interactive → aborts)

## Files Changed

| File | Change |
|------|--------|
| `drone-agent/src/plugins/subagent/plugin.ts` | Activity-based timeout + hard cap; error event handling; fallback to last error in close handler; updated tool description |
| `drone-agent/src/interactive.ts` | Catch errors from `sendUserMessage` in `runJsonMode`; emit error + return events; exit with code 1 |
| `drone-agent/src/tui/components/SubagentDispatchBlock.tsx` | Handle `error:` prefix in `renderLastAction` |
| `drone-agent/test/fixtures/subagent.ts` | Mirror timeout changes (activity timer + hard cap) |
| `drone-agent/test/subagent/dispatch.test.ts` | Tests for activity-based timeout, hard cap timeout, error event handling |
| `drone-agent/test/subagent-dispatch-block.test.tsx` | Test for `error:` prefix rendering |

## Related

- subagent — Subagent system overview
- [080-subagent-dispatch-pretty-output](080-subagent-dispatch-pretty-output.md) — Subagent dispatch TUI rendering with live progress
