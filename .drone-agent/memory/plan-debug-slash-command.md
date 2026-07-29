---
key: plan-debug-slash-command
tags:
  []
created: 2026-07-29T04:19:37.909Z
updated: 2026-07-29T04:19:37.909Z
---

# Plan: `/debug` Slash Command for Runtime Debug Subsystem Toggling

## Summary

Add a `/debug` built-in slash command that lets users enable and disable debug subsystems at runtime, without restarting the agent. Currently, `--debug llm` can only be set at startup via the CLI flag. This command makes it possible to toggle LLM request/response logging mid-session.

## Design

- **Built-in command** (registered in `builtin-commands.ts`, lower precedence than plugin commands)
- **Syntax:** `/debug enable|disable <subsystem>` — e.g., `/debug enable llm`, `/debug disable llm`
- **No-args behavior:** Shows current state + usage (consistent with `/model` and `/reasoning`)
- **No validation of subsystem names** — any string is accepted, matching the existing convention that subsystem names are just conventions consumed by the code that checks `debugSet.has(...)`
- **Output goes to the logger** (info/warn), which in TUI mode appears in the chat log

## Data Flow

The `debugSet: Set<string>` in `conversation-service.ts` is currently a local `const` that is never exposed. The plan adds three methods to the `ConversationService` type to read and mutate it:

```
/debug enable llm
  → builtin-commands.ts handler
    → ctx.conversation.enableDebugSubsystem('llm')
      → conversation-service.ts: debugSet.add('llm')
        → next provider.chat() call: debugSet.has('llm') === true
          → LLM provider logs request/response to stderr
```

## Files to Modify

### 1. `drone-core/src/plugin-system.ts` — Add debug methods to `DroneSlashCommandContext.conversation`

Add three methods to the `conversation?` type:

```typescript
conversation?: {
  // ... existing methods ...
  getDebugSubsystems: () => string[];
  enableDebugSubsystem: (name: string) => void;
  disableDebugSubsystem: (name: string) => void;
};
```

### 2. `drone-agent/src/runtime/conversation-service.ts` — Expose debug set on `ConversationService`

Add three methods to the `ConversationService` type and their implementations in the returned object:

```typescript
export type ConversationService = {
  // ... existing methods ...
  getDebugSubsystems: () => string[];
  enableDebugSubsystem: (name: string) => void;
  disableDebugSubsystem: (name: string) => void;
};
```

Implementation (the `debugSet` is already a `const Set`, which is mutable):

```typescript
getDebugSubsystems: () => Array.from(debugSet),
enableDebugSubsystem: (name: string) => {
  debugSet.add(name);
},
disableDebugSubsystem: (name: string) => {
  debugSet.delete(name);
},
```

### 3. `drone-agent/src/runtime/builtin-commands.ts` — Add `/debug` command

Add a new `debugCommand` constant and include it in the `BUILT_IN_SLASH_COMMANDS` array.

Handler logic:
- If `ctx.conversation` is absent → warn and return
- If no args → show current subsystems + usage
- If args.length !== 2 → show usage
- If first arg is not 'enable' or 'disable' → warn with valid actions
- Otherwise → call `enableDebugSubsystem` or `disableDebugSubsystem` and log success

### 4. `drone-agent/src/interactive.ts` — Add debug methods to conversation adapter

In the `conversation:` object passed to `dispatchSlashCommand`, add:

```typescript
getDebugSubsystems: () => conversation.getDebugSubsystems(),
enableDebugSubsystem: name => conversation.enableDebugSubsystem(name),
disableDebugSubsystem: name => conversation.disableDebugSubsystem(name),
```

### 5. `drone-agent/src/tui/types.ts` — Add debug methods to `DroneTuiOptions.conversation`

Add the same three methods to the `conversation` type in `DroneTuiOptions`.

### No changes needed to:
- `drone-agent/src/tui/app.tsx` — already passes `opts.conversation` (the full `ConversationService`) directly
- `drone-agent/src/cli.ts` — no change needed; the CLI flag still works as before
- `drone-agent/src/index.tsx` — no change needed; the conversation service already receives `debugSubsystems`

## Validation Criteria

1. **LSP passes** — no type errors in any of the 5 modified files
2. **`pnpm -r run build` passes** — all packages compile cleanly
3. **`pnpm -r run lint` passes** — eslint + prettier
4. **`pnpm -r run test` passes** — all existing tests still pass
5. **Manual verification:**
   - Start drone-agent with `--debug llm` → LLM requests are logged to stderr
   - Run `/debug` (no args) → shows "Debug subsystems: llm" + usage
   - Run `/debug disable llm` → shows "Debug subsystem \"llm\" disabled." → subsequent LLM calls are NOT logged
   - Run `/debug enable llm` → shows "Debug subsystem \"llm\" enabled." → subsequent LLM calls ARE logged again
   - Run `/debug enable mcp` → succeeds (no validation) — harmless, no code checks for "mcp" yet
   - Run `/debug invalid llm` → shows error about valid actions
   - Run `/debug enable` (missing subsystem) → shows usage
