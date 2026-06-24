---
key: subagent-impl-plan
tags:
  - subagents
  - implementation
  - completed
created: 2026-06-24T22:54:28.315Z
updated: 2026-06-24T23:00:54.056Z
---

# Subagents Implementation Plan (COMPLETED)

## Status: ✅ IMPLEMENTED

All phases from the original plan have been implemented.

---

## Summary of Changes

### Files Modified

| File | Change |
|------|--------|
| `drone-agent/src/output-handlers.ts` | Added `OutputEvent` type, `makeNdjsonOutputEventHandler()`, and `writeNdjsonEvent()` for NDJSON output |
| `drone-agent/src/interactive.ts` | Added `InputEvent` type, `readNdjsonInput()`, and `runJsonMode()` for JSON input mode |
| `drone-agent/src/index.tsx` | Added `--once + --output-json` branch to call `runJsonMode()` for subagent mode |
| `drone-agent/src/plugins/subagent/plugin.ts` | Full implementation of `subagent.dispatch` and `subagent.return` with spawn, timeout, crash handling |

---

## Implemented Features

### Phase 2: Subagent Plugin
- ✅ `subagent.dispatch` - Spawns child process with `--subagent-id --output-json --once`, writes kickoff to stdin, parses NDJSON output
- ✅ `subagent.return` - Outputs proper `{ kind: "return", result, error }` NDJSON event, exits process

### Phase 4: JSON Protocol
- ✅ JSON Input Mode - Reads `{ type: "kickoff", task: "..." }` from stdin in `--once --output-json` mode
- ✅ JSON Output Mode - Emits NDJSON lines: `{ kind: "assistantMessage" }`, `{ kind: "toolCall" }`, `{ kind: "toolResult" }`, etc.

### Phase 3: Parallel Dispatch  
- ✅ Each dispatch returns a Promise; users can use `Promise.all([dispatch(), dispatch()])` for parallel execution

### Phase 5: Error Handling
- ✅ Timeout - 5 minute default (configurable via `timeout` param), kills process on timeout
- ✅ Crash Detection - Listens for `close` event, reports non-zero exit codes as errors

---

## Event Schema

### Input (stdin, JSON mode)
```json
{ "type": "kickoff", "task": "The prompt to send to subagent" }
```

### Output (stdout, JSON mode)
```json
{ "kind": "assistantMessage", "content": "Hello" }
{ "kind": "reasoning", "content": "Let me think..." }
{ "kind": "toolCall", "name": "file.read", "input": { "path": "/foo" } }
{ "kind": "toolResult", "name": "file.read", "result": "file content" }
{ "kind": "error", "message": "Something went wrong" }
{ "kind": "return", "result": "final answer", "error": null }
```

---

## Usage Examples

### Dispatch a subagent
```typescript
const result = await subagent.dispatch({ task: "Analyze the codebase" });
// Returns: { "result": "...", "exitCode": 0 } or { "error": "...", "exitCode": 1 }
```

### Parallel dispatch
```typescript
const [r1, r2, r3] = await Promise.all([
  subagent.dispatch({ task: "do A" }),
  subagent.dispatch({ task: "do B" }),
  subagent.dispatch({ task: "do C" }),
]);
```

### Subagent returning result
```typescript
await subagent.return({ result: "Analysis complete" });
// Outputs NDJSON and exits
```

---

## Design Decisions

1. **JSON Output Format**: Structured event objects (B choice)
2. **JSON Input Format**: `{ type: "kickoff", task: "..." }` - general purpose
3. **Default Timeout**: 5 minutes (300,000 ms)
4. **One-shot Flag**: Reused existing `--once` flag

---

## Remaining/Open Items

- Documentation in AGENTS.md (not yet written)
- Tests (not yet written)
- Potential improvements: context passing, custom executable path