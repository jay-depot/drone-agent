---
key: subagent-roadmap
tags:
  - subagents
  - architecture
  - roadmap
created: 2026-06-24T22:30:20.790Z
updated: 2026-06-24T22:30:20.790Z
---

# Subagents Feature — Project Roadmap

## Overview

Add support for launching subagents from within an agent session, with the main agent blocking until all subagents complete (or error/timeout).

## Architecture

### 1. CLI Changes (`cli.ts`)

Add `--subagent-id` flag with fallback chain:

```
--subagent-id <id>   # CLI flag (highest priority)
DRONE_SUBAGENT_ID=<id>   # Environment variable fallback
(then default: persona from config/defaults)
```

Also add `--persona` flag:

```
--persona <name>     # Startup persona (CLI)
DRONE_PERSONA=<name> # Environment variable fallback
(defaults from config)
```

| Flag | Type | Description |
|------|------|--------------|
| `--subagent-id` | `string?` | ID used by parent to identify this subagent; presence = subagent mode |
| `--persona` | `string?` | Persona to load at startup |

### 2. Subagent Detection Logic

In plugin initialization, check:

1. Is `--subagent-id` present in CLI args or `DRONE_SUBAGENT_ID` env var?
2. If yes → **subagent mode** (session is a subagent)
3. If no → **main agent mode** (session is the primary agent)

### 3. Plugin Architecture

Two new tools, exposed conditionally:

| Tool | Main Agent | Subagent |
|------|------------|----------|
| `subagent.dispatch` | ✅ Exposed | ❌ Hidden |
| `subagent.return` | ❌ Hidden | ✅ Exposed |

#### `subagent.dispatch` (Main Agent Only)

```typescript
{
  name: 'subagent.dispatch',
  description: 'Launch a subagent to handle a task in parallel',
  input: {
    task: string,          // The prompt to send to subagent
    persona?: string,      // Optional persona override
    timeout?: number,      // Optional timeout (ms), default from config
  },
  output: {
    // Blocking: waits for result
    result?: string,       // The subagent's return value
    error?: string,        // Error message if subagent failed
    timedOut?: boolean,    // Whether it timed out
    exitCode?: number,     // Process exit code if known
  }
}
```

#### `subagent.return` (Subagent Only)

```typescript
{
  name: 'subagent.return',
  description: 'Return the result to the parent agent',
  input: {
    result: string,        // The result to send back
    error?: string,        // Optional error info
  },
  output: void  // Exits after returning
}
```

### 4. Subagent Lifecycle

```
Main Agent                            Subagent Process
    |                                      |
    |--- spawns with --subagent-id -------->|
    |     --output-json                     |
    |     stdin: kickoff prompt             |
    |                                      |
    |         (runs to completion)         |
    |                                      |
    |<-- outputs NDJSON with result field -|
    |                                      |
    | (blocks until all complete)          |
    v                                      v
```

1. **Launch**: Main agent spawns child process with:
   - `--subagent-id <id>` (if passing parent context)
   - `--output-json` 
   - `--once` (one-shot mode)
   - `--persona <name>` (if specified)
   - stdin: kickoff prompt

2. **Execute**: Subagent runs with full blocking, exits when done

3. **Return**: Subagent calls `subagent.return({ result: "..." })` which:
   - Outputs JSON with `{ type: "return", result: "...", error?: "..." }`
   - Exits the process

4. **Collect**: Parent reads NDJSON, looks for `return` event, blocks until all complete

### 5. Parallel Execution

```typescript
// Main agent can call dispatch multiple times
const [r1, r2, r3] = await Promise.all([
  subagent.dispatch({ task: "do A" }),
  subagent.dispatch({ task: "do B" }),
  subagent.dispatch({ task: "do C" }),
]);
// Blocks until all return, error, or timeout
```

Implementation: Track multiple pending subagents, use `Promise.all` semantics.

### 6. NDJSON Protocol Update

Current `--output-json` outputs each event as JSON line. Extend to support:

**Input** (stdin in JSON mode):
```
{ "type": "kickoff", "task": "...", "context": {...} }
```

**Output** (stdout in JSON mode):
```
{ "kind": "assistantMessage", "content": "..." }
{ "kind": "toolCall", "name": "...", "input": {...} }
{ "kind": "toolResult", "name": "...", "result": "..." }
{ "type": "return", "result": "...", "error": "..." }
```

### 7. Error Handling

- **Crashes**: Non-zero exit code → reported as error in dispatch result
- **Timeouts**: No activity for N ms → kill process, report `timedOut: true`
- **subagent.return error field**: Optional, for graceful error reporting

### 8. Restrictions

- **No nesting**: Subagents cannot spawn subagents (enforced by not exposing `subagent.dispatch`)
- **One-shot**: Subagent process exits after returning

---

## Implementation Phases

### Phase 1: CLI + Detection
- Add `--subagent-id` and `--persona` flags
- Add env var fallback
- Detect subagent mode in plugin init

### Phase 2: Subagent Plugin + Tools
- Create `subagent` plugin
- Implement `subagent.dispatch` (spawns process, parses output)
- Implement `subagent.return` (outputs JSON, exits)
- Conditional tool exposure based on mode

### Phase 3: Parallel Dispatch
- Handle multiple concurrent dispatches
- Implement `Promise.all`-like blocking

### Phase 4: NDJSON Protocol
- Update `--output-json` to support structured input
- Add `type: "return"` event type

### Phase 5: Error Handling + Polish
- Timeout handling
- Crash detection
- Error field in return tool

---

## Files to Modify/Create

| File | Change |
|------|--------|
| `src/cli.ts` | Add `--subagent-id`, `--persona` flags |
| `src/plugins/subagent/plugin.ts` | **New** — dispatch/return tools |
| `src/plugins/subagent/index.ts` | **New** — plugin registration |
| `src/interactive.ts` | Update to support JSON input mode |
| `src/output-handlers.ts` | Add JSON event types |
| `src/index.tsx` | Pass subagent ID to engine/plugins |
| `src/runtime/plugin-engine.ts` | Expose CLI options to plugins |
| `drone-core/src/types.ts` | Add new types if needed |

---

## Open Decisions (Can Be Deferred)

1. **Default timeout value?** → Configurable, default maybe 5 min
2. **Context passing?** → For v1, just kickoff prompt; can add later
3. **How parent passes parent ID?** → Via `--subagent-id` in child args