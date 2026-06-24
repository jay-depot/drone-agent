---
key: subagent-impl-plan
tags:
  - subagents
  - implementation
  - plan
  - v2
created: 2026-06-24T22:54:28.315Z
updated: 2026-06-24T22:54:28.315Z
---

# Subagents Implementation Plan (v2)

## Answers to Design Questions

1. **JSON Output Format**: Use structured event objects matching output-handlers format
2. **JSON Input Format**: General-purpose `type: "kickoff"` with `task` field
3. **Default Timeout**: 5 minutes (300,000 ms)
4. **One-shot Flag**: Reuse existing `--once` flag ✓
5. **Implementation Order**: Phase 2 → 4 → 3 → 5 (all the way through)

---

## Implementation Plan

### Phase 2: Subagent Plugin Dispatch/Return

**File: `drone-agent/src/plugins/subagent/plugin.ts`**

#### 2.1 Implement `subagent.dispatch` (Main Agent Only)

- Spawns child process with:
  - `--subagent-id <id>` (unique ID)
  - `--output-json` (JSON mode)
  - `--once` (one-shot mode)
  - `--persona <name>` (optional)
- stdin: kickoff prompt in JSON format
- parses NDJSON output, extracts return event
- returns: `{ result, error?, timedOut?, exitCode? }`

#### 2.2 Implement `subagent.return` (Subagent Only)

- Output proper NDJSON with structured event format
- Use `type: "return"` event with `result` and optional `error` fields
- Exit process after outputting

### Phase 4: JSON Protocol (Input + Output)

**File: `drone-agent/src/interactive.ts`** and **`drone-agent/src/output-handlers.ts`**

#### 4.1 JSON Input Mode

When `--output-json` AND `--once` (subagent mode):
- Read stdin as NDJSON
- Parse first line as `{ type: "kickoff", task: "..." }`
- Execute the task instead of interactive loop

#### 4.2 JSON Output Mode

When `--output-json`:
- Emit structured event objects as NDJSON lines:
  - `{ "kind": "assistantMessage", "content": "..." }`
  - `{ "kind": "toolCall", "name": "...", "input": {...} }`
  - `{ "kind": "toolResult", "name": "...", "result": "..." }`
  - `{ "kind": "reasoning", "content": "..." }`
  - `{ "kind": "error", "message": "..." }`
  - `{ "type": "return", "result": "...", "error": "..." }` ← for subagent

### Phase 3: Parallel Dispatch

When main agent calls `dispatch` multiple times:
- Track pending subagents in a map
- Allow concurrent dispatches
- Use `Promise.all` semantics - wait for all to complete
- Return array of results in order

### Phase 5: Error Handling

#### 5.1 Timeout Handling
- Default: 5 minutes (configurable via `timeout` param)
- Use `setTimeout` to kill process if no activity
- Track "activity" as any NDJSON line received

#### 5.2 Crash Detection
- Listen for `exit` event on child process
- Non-zero exit code → report as error

---

## Files to Modify

| File | Change |
|------|--------|
| `drone-agent/src/plugins/subagent/plugin.ts` | Implement dispatch/return with full logic |
| `drone-agent/src/output-handlers.ts` | Add NDJSON output handler |
| `drone-agent/src/interactive.ts` | Add JSON input mode for stdin kickoff |
| `drone-agent/src/index.tsx` | Wire JSON input mode in appropriate flow |

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
{ "type": "return", "result": "final answer", "error": null }
```

---

## Implementation Sequence

1. **Update output-handlers.ts** - Add NDJSON handler
2. **Update interactive.ts** - Add JSON input mode (stdin read)
3. **Update index.tsx** - Wire JSON mode flow
4. **Update subagent plugin.ts** - Full dispatch implementation
5. **Add parallel dispatch** - Track multiple pending
6. **Add timeout/crash handling** - Final polish