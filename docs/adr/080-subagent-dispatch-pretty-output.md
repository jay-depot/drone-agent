---
tags: [decision, tui, rendering, subagent]
related: [078-pretty-tool-output.md, 079-pretty-tool-output-phase-2.md, 081-meta-tool-pretty-output.md, concepts/subagent.md, modules/drone-agent-tui.md]
---

# ADR 080: Subagent Dispatch Pretty Output

**Status**: Implemented (commit `ce5eb8b`, 2026-07-21)

## Context

The `subagent__dispatch` tool showed no custom TUI rendering — it fell back to the generic `ToolCallProgress` JSON-blob display. Users couldn't see what the subagent was doing while it ran, only the final result.

## Decision

Add a custom TUI render component for `subagent__dispatch` that shows the kickoff prompt (markdown-rendered), a thin horizontal rule divider, and a live-updating "last subagent action" line while the subagent runs. When the subagent completes, the last action naturally transitions into the subagent's return result (markdown-rendered).

Also adds real-time NDJSON event parsing to the subagent's stdout stream so the parent agent can monitor subagent progress as it happens.

### Real-time NDJSON Parsing

Added `onProgress` parameter to the `dispatch` tool's `execute` function. Each stdout line from the subagent is parsed as NDJSON and converted to a progress string:

- `{kind:"reasoning", content:"..."}` → `reasoning:<text>`
- `{kind:"toolCall", name:"...", input:{...}}` → `tool:<name>(<truncated-args>)`
- `{kind:"assistantMessage", content:"..."}` → `msg:<truncated-content>`
- `{kind:"return", result:"..."}` → `done:<result>`

Args truncated to ~80 chars, message content to ~120 chars.

### SubagentDispatchBlock Component

- **Running state**: `… subagent__dispatch - <persona>` header, markdown-rendered kickoff, divider, and last action
- **Done state**: `✓` header, markdown-rendered kickoff, divider, and markdown-rendered result
- **Error state**: `✗` header, markdown-rendered kickoff, divider, and error message
- **Last action rendering**: reasoning in gray, tool calls with `⚡` prefix, messages as plain text, done as markdown

### Tests

10 tests covering: running state with/without persona, reasoning/tool call/assistant message as last action, done state with result and with error result, error state with and without result message, most recent output line shown as last action.

## Consequences

### Positive
- Subagent dispatch now shows live progress in the TUI
- NDJSON parsing infrastructure reusable for other features
- Users can see what subagents are doing in real-time

### Negative
- Subagent stdout parsing adds complexity to the dispatch tool
- Progress strings are truncated (may lose detail for very long messages)

## Related

- [[078-pretty-tool-output]] — Phase 1: 7 core tools
- [[079-pretty-tool-output-phase-2]] — Phase 2: 12 more tools
- [[081-meta-tool-pretty-output]] — Reusable list/mount/unmount meta-tool components
- [[concepts/subagent]] — Subagent system documentation
- [[modules/drone-agent-tui]] — TUI module documentation
