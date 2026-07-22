---
key: mcp-mount-tool-return-canonical-name
tags:
  - plan
  - mcp
  - tool-mounting
created: 2026-07-22T01:40:31.200Z
updated: 2026-07-22T01:40:31.200Z
---

# MCP Mount Tool: Return Full Canonical Name

## Summary
When the LLM mounts an MCP tool via `__mount_tool`, the return value's `tool` field currently contains the internal cache key (e.g., `"web_search"`) instead of the full canonical name the LLM should use to call the tool (e.g., `"mcp__searxng__web_search"`). This causes confusion when agents try to use the returned name directly.

## Plan

### Step 1 — Modify the `__mount_tool` return value (1-2 lines)

**File:** `drone-agent/src/plugins/mcp/index.ts`
**Location:** Inside `mountMetaTools()`, in the `__mount_tool` handler, after `cache.mountTool(toolName, registration)` succeeds (~line 370-380).

**Change:**
```typescript
// Before:
return JSON.stringify(
  {
    success: true,
    tool: toolName,
    description: toolMeta.description,
  },
  null,
  2
);

// After:
const mountedName = cache.getToolDefName(toolName);
const canonicalName = mountedName ? `mcp__${mountedName}` : toolName;
return JSON.stringify(
  {
    success: true,
    tool: canonicalName,
    description: toolMeta.description,
  },
  null,
  2
);
```

This changes the `tool` field from `"web_search"` to `"mcp__searxng__web_search"` — the exact name the LLM should use to call the tool.

### Step 2 — Verify the fix
1. Run `pnpm build` to ensure compilation passes
2. Run `pnpm -r run lint` to ensure linting passes
3. Run `pnpm -r run test` to ensure tests pass
4. Check LSP diagnostics are clean

### Validation Criteria
- [ ] LSP diagnostics are clean (no errors or warnings)
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run test` passes (fast test suite)
- [ ] The `__mount_tool` return value includes the full canonical name (e.g., `"mcp__searxng__web_search"`) instead of just the internal key