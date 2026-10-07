---
tags: [decision, context-budget, conversation]
related: [session-management.md, tool-call-loop.md, drone-core.md]
---

# 096 — Tool Result Truncation for Context Budget

**Summary**: Added a configurable per-tool-result token cap in the conversation service. When any tool returns a result whose estimated token count exceeds a percentage of the context window, the result is truncated with a note indicating the original size. This prevents a single large tool result (e.g., `cat hugefile.log`, `find /`) from consuming a disproportionate share of the context window, which is especially problematic on 128K–256K token models.

## Context

The tool result pipeline was unbounded — `exec__run` accumulated all stdout/stderr in memory, `file__read` returned entire files, and none of it was ever truncated. The only aggregate controls were the safety trim (drops entire turns) and compaction (summarizes entire turns), but neither addressed the case where a single tool result could consume most of the context window.

On million-token models (Claude Opus, Gemini) this was rarely a problem. But on 128K–256K models (common for Ollama, smaller OpenAI models), a single `cat hugefile.log` or `find /` could eat the entire budget.

## Decision

Add a configurable percentage-based cap on individual tool results, applied at the conversation service layer (after `executeToolSafely` returns, before results are appended to the session manager). This is a single point that covers all tools generically.

### Key design choices

1. **Conversation service layer** — Applied after `executeToolSafely` returns but before results reach the session manager. This is a single point covering all tools (exec, file, search, MCP, etc.) without modifying each tool individually.

2. **Percentage of context window** — Uses `session.maxToolResultTokensPercent` (default: 15%) of the resolved context window. For a 128K window: ~19,200 tokens (~77KB). For 256K: ~38,400 tokens (~154KB). For 1M: ~150K tokens (~600KB).

3. **Token estimation** — Uses the existing `estimateTextTokens` function (chars/4), consistent with the rest of the project's token estimation.

4. **Truncation note** — The truncated content includes a note with the original size and guidance:
   - For `file__read` and similar tools: request a smaller window
   - For `exec__run`: pipe output to a temp file and read that

5. **Only successful results** — Error results (`kind: 'error'`) are typically small and pass through unchanged.

6. **Configurable disable** — Setting `maxToolResultTokensPercent: 0` disables truncation entirely.

## Implementation

### Files changed

- **`drone-core/src/config-types.ts`** — Added `maxToolResultTokensPercent?: number` to `DroneSessionConfig` with jsdoc; default `15` in `createDefaultAgentConfig()`
- **`drone-core/src/config-schema.ts`** — Added `maxToolResultTokensPercent: Type.Optional(Percent)` to the session schema
- **`drone-agent/src/runtime/conversation-service.ts`** — Imported `estimateTextTokens`; added `truncateToolResult()` helper; added truncation logic after `rawResults` are collected and before the `bufferedResults` loop
- **`drone-agent/test/conversation-service.test.ts`** — Three test cases: truncation of large result, pass-through of small result, disabled when percent is 0

### Truncation function

```typescript
function truncateToolResult(content: string, maxTokens: number): string {
  if (maxTokens <= 0) return content;
  const estimatedTokens = estimateTextTokens(content);
  if (estimatedTokens <= maxTokens) return content;
  const maxChars = maxTokens * 4;
  const truncated = content.slice(0, maxChars);
  return `${truncated}\n\n[Output truncated at ~${maxTokens} tokens. Full output was ~${estimatedTokens} tokens. For file__read and similar tools, request a smaller window. For exec__run, if you need the full output, consider piping the output of the command into a temp file and reading that.]`;
}
```

### Insertion point

The truncation runs after `Promise.all(toolCalls.map(...))` resolves and before the `bufferedResults` loop. The context window is re-resolved via `budgetService.resolveContextWindow()` each iteration, so it adapts to model/provider changes.

## Related

- [[session-management]] — Context budgeting and safety trim
- [[tool-call-loop]] — How the conversation service processes tool calls
- [[drone-core]] — Token estimation functions
