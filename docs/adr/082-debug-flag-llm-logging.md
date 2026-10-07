---
tags: [decision, cli, debugging, llm]
related: [modules/drone-agent.md, modules/drone-core.md]
---

# ADR 082: `--debug` CLI Flag with LLM Request/Response Logging

**Status**: Implemented (2026-07-21)

## Context

Debugging LLM provider issues required manually adding `console.log` statements or inspecting network traffic. There was no built-in mechanism to see what the agent was actually sending to and receiving from LLM providers.

## Decision

Add a `--debug` CLI flag that accepts a comma-separated list of subsystem names. When `--debug llm` is passed, the LLM providers log their full request and response bodies to stderr. The flag supports both `--debug llm,mcp` and `--debug llm --debug mcp` syntax, consistent with the existing `--plugin` flag.

### Design Decisions

1. **Output goes to stderr** — clean separation from TUI/plain output, can be redirected with `2> debug.log`
2. **Debug flag threaded through `DroneLlmProvider.chat()` input** — the `debug?: boolean` field is added to the chat input type. The conversation service sets it to `true` when `'llm'` is in the debug subsystems set. This is surgical and doesn't pollute the engine or config interfaces.
3. **Each provider logs independently** — the logging is done in each provider's `chat()` function, not in a central place. This keeps the logging close to the actual request/response and avoids needing to reconstruct what was sent.
4. **Log format** — `[llm:request]` and `[llm:response]` prefixed lines to stderr, grep-able and consistent.

### Implementation

**Files changed (7):**

| File | Change |
|------|--------|
| `drone-agent/src/cli.ts` | Added `debugSubsystems: string[]` to `CliOptions`, parsed `--debug` flag (comma-separated and repeated forms) |
| `drone-core/src/provider-types.ts` | Added `debug?: boolean` to chat input type |
| `drone-agent/src/runtime/conversation-service.ts` | Threaded `debugSubsystems` through, passes `debug: debugSet.has('llm')` to provider |
| `drone-agent/src/index.tsx` | Wired debug subsystems from CLI to conversation service |
| `drone-agent/src/plugins/openai/index.ts` | Logs request body before fetch, reads response as text, logs it, then parses JSON |
| `drone-agent/src/plugins/openrouter/index.ts` | Same pattern, also logs retry request/response on tool-routing errors |
| `drone-agent/src/plugins/anthropic/index.ts` | Same pattern |
| `drone-agent/src/plugins/ollama.ts` | Logs input params before `client.chat()`, logs response after |

### Tests

Added tests for each provider verifying debug output is written to stderr when `debug: true` is passed, and that existing behavior is unchanged when omitted.

## Consequences

### Positive
- Easy debugging of LLM provider issues without code changes
- Consistent log format across all 4 providers
- Clean separation from normal output (stderr)
- Extensible to future subsystems (e.g., `--debug mcp`)

### Negative
- Slightly more complex CLI parsing
- Each provider must implement its own logging (duplication, but intentional for proximity to the actual I/O)

## Related

- [drone-agent](../../drone-agent/) — The agent package
- [drone-core](../../drone-core/) — Shared types including provider types
