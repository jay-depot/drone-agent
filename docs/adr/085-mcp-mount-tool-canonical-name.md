---
tags: [decision, mcp, tool-mounting]
related: [modules/drone-agent-mcp-client.md]
---

# Decision 085: MCP Mount Tool Returns Full Canonical Name

**Summary**: The `__mount_tool` meta-tool now returns the full canonical tool name (e.g., `"mcp__searxng__web_search"`) instead of the internal cache key (`"web_search"`), preventing agents from using the wrong name when they read the mount result.

## Context

When the LLM calls `mcp__searxng__mount_tool({ tool: "web_search" })`, the result said `{ tool: "web_search" }` — the internal cache key. But the tool was actually registered as `mcp__searxng__web_search`. Agents that tried to use the returned name directly would fail because they were missing the `mcp__` prefix.

## Decision

After `cache.mountTool()` succeeds, use `cache.getToolDefName()` to get the short mounted name (e.g., `"searxng__web_search"`), prepend `"mcp__"` to form the canonical name, and return that in the `tool` field.

### Change

A 3-line addition in `drone-agent/src/plugins/mcp/index.ts`:

```typescript
const mountedName = cache.getToolDefName(toolName);
const canonicalName = mountedName ? `mcp__${mountedName}` : toolName;
// ... then return { success: true, tool: canonicalName, ... }
```

## Consequences

- Agents can now use the returned `tool` value directly to reference the mounted tool
- Backward-compatible: the `__list_tools` output is unchanged (still shows internal keys for `__mount_tool` input)
- Two test assertions updated to match the new return value
