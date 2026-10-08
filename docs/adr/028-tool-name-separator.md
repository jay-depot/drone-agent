---
tags: [decision, tool-names, kimi-compatibility]
related: [modules/drone-core.md, modules/drone-agent-plugins.md]
---

# ADR 028: Tool Name Separator Change (Dot → Double Underscore)

**Summary**: Changed the canonical tool name separator from `.` to `__` to fix compatibility with Kimi 2.7 Code, which hallucinates tool names containing dots because its internal parser treats the dot as a structural separator in the `functions.{name}:{idx}` tool call ID format.

## Context

Kimi 2.7 Code (and the entire Kimi K2 family) was observed calling a nonexistent tool `"run"` repeatedly in a degenerate loop. Investigation revealed that drone-agent's tool names use a dot-separated format (`plugin.tool`), e.g., `exec.run`, `file.read`, `git.status`.

The Kimi K2 paper (arXiv 2507.20534, Appendix B) documents that the model's internal tool-call ID format is `functions.{tool-name}:{counter}`, where the dot is a structural separator between the `functions` prefix and the tool name. When a tool name itself contains a dot (like `exec.run`), the parser breaks — it expects exactly one dot (the `functions.` prefix), not two.

The vLLM team's debugging deep-dive (October 2025) confirmed this exact issue: Kimi K2's tool-call parser uses code equivalent to `function_id.split('.')[1].split(':')[0]` to extract the function name, which fails on tool names with embedded dots.

Kimi's official API documentation states: "The name of the function, please use English letters, numbers, hyphens, and underscores as the function name" — explicitly excluding dots.

## Decision

Change `getCanonicalToolName` in `drone-core/src/utils.ts` to use `__` (double underscore) instead of `.` (dot) as the separator between plugin ID and tool name.

```typescript
// Before:
export function getCanonicalToolName(
  pluginId: string,
  toolName: string
): string {
  return `${pluginId}.${toolName}`;
}

// After:
export function getCanonicalToolName(
  pluginId: string,
  toolName: string
): string {
  return `${pluginId}__${toolName}`;
}
```

## Blast Radius

The change touched 37 files across the monorepo:

- **Core function**: `drone-core/src/utils.ts` — single source of truth
- **Plugin error messages** (6 files): `file.ts`, `exec.ts`, `git.ts`, `search.ts`, `todo.ts`, `self-improvement/index.ts`
- **Internal dispatch calls** (8 files): `skills/index.ts`, `persona/index.ts`, `lsp/tools.ts`, `subagent/plugin.ts`, `mcp/index.ts`, `cli.ts`, `builtin-commands.ts`, `tui/app.tsx`, `index.tsx`
- **Test files** (15 files): All hardcoded tool name references updated
- **Documentation** (2 files): `README.md`, `AGENTS.md`

## Consequences

**Positive**:

- Kimi 2.7 Code should now correctly recognize and call tools without hallucinating nonexistent ones
- The `__` separator uses only characters in `[a-zA-Z0-9_-]`, which is compatible with all major LLM providers' tool-calling formats

**Negative**:

- Breaking change for any user with custom personas using `allowedTools` patterns like `exec.*` — these must be updated to `exec__*`
- Breaking change for any user scripts or documentation referencing tool names
- The CLI `--workflow` flag now expects `plugin__workflow` format instead of `plugin.workflow`

## Related

- [drone-core](../../drone-core/) — Contains the `getCanonicalToolName` function
- [drone-agent-plugins](../../drone-agent/src/plugins/) — All plugins affected by the change
