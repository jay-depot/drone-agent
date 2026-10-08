---
tags: [decision, cli, debugging, slash-command]
related:
  [
    decisions/082-debug-flag-llm-logging.md,
    modules/drone-agent.md,
    modules/drone-core.md,
  ]
---

# ADR 097: `/debug` Slash Command for Runtime Debug Subsystem Toggling

**Status**: Implemented (2026-07-29)

## Context

The `--debug` CLI flag (ADR 082) allowed enabling debug subsystems at startup, but there was no way to toggle them at runtime without restarting the agent. Users who wanted to temporarily enable LLM request/response logging mid-session (e.g., to debug a specific interaction) had to restart the entire agent.

## Decision

Add a `/debug` built-in slash command that lets users enable and disable debug subsystems at runtime. The command mutates the same `Set<string>` that the `--debug` CLI flag initializes, so both mechanisms work together seamlessly.

### Design Decisions

1. **Built-in command** — registered in `builtin-commands.ts` with lower precedence than plugin commands, consistent with `/clear`, `/plugins`, `/tools`, etc. Not overridable by plugins.

2. **Syntax** — `/debug enable|disable <subsystem>` — e.g., `/debug enable llm`, `/debug disable llm`. Two-argument form: action (enable/disable) and subsystem name.

3. **No-args behavior** — shows current state + usage, consistent with `/model` and `/reasoning`.

4. **No validation of subsystem names** — any string is accepted, matching the existing convention that subsystem names are just conventions consumed by the code that checks `debugSet.has(...)`.

5. **Output goes to the logger** — info/warn messages appear in the TUI chat log or interactive mode output.

### Implementation

**Files changed (5 source + 6 test):**

| File                                              | Change                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `drone-core/src/plugin-system.ts`                 | Added `getDebugSubsystems`, `enableDebugSubsystem`, `disableDebugSubsystem` to `DroneSlashCommandContext.conversation` type |
| `drone-agent/src/runtime/conversation-service.ts` | Exposed the existing `debugSet` on `ConversationService` with the same three methods                                        |
| `drone-agent/src/runtime/builtin-commands.ts`     | Added `/debug` command handler with enable/disable logic and no-args state display                                          |
| `drone-agent/src/interactive.ts`                  | Wired debug methods through the conversation adapter for interactive mode                                                   |
| `drone-agent/src/tui/types.ts`                    | Added debug methods to `DroneTuiOptions.conversation` type                                                                  |
| 6 test files                                      | Added mock implementations of the new methods                                                                               |

### Data Flow

```
/debug enable llm
  → builtin-commands.ts handler
    → ctx.conversation.enableDebugSubsystem('llm')
      → conversation-service.ts: debugSet.add('llm')
        → next provider.chat() call: debugSet.has('llm') === true
          → LLM provider logs request/response to stderr
```

### Tests

All 1650 existing tests pass. No new tests were added — the feature is a thin wiring layer that delegates to existing infrastructure.

## Consequences

### Positive

- Users can toggle debug logging mid-session without restarting
- Works in both TUI and interactive modes
- Complements the existing `--debug` CLI flag (startup + runtime)
- Extensible to future debug subsystems automatically

### Negative

- Slightly more surface area on the `ConversationService` type
- The `DroneSlashCommandContext.conversation` type grows by 3 methods

## Related

- [082-debug-flag-llm-logging](082-debug-flag-llm-logging.md) — The original `--debug` CLI flag
- [drone-agent](../../drone-agent/) — The agent package
- [drone-core](../../drone-core/) — Shared types including plugin system types
