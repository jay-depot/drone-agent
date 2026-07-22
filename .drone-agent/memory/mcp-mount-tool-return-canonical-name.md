---
key: mcp-mount-tool-return-canonical-name
tags:
  - plan
  - mcp
  - tool-mounting
  - completed
created: 2026-07-22T01:40:31.200Z
updated: 2026-07-22T01:44:20.586Z
---

# MCP Mount Tool: Return Full Canonical Name

## Summary
When the LLM mounts an MCP tool via `__mount_tool`, the return value's `tool` field currently contains the internal cache key (e.g., `"web_search"`) instead of the full canonical name the LLM should use to call the tool (e.g., `"mcp__searxng__web_search"`). This causes confusion when agents try to use the returned name directly.

## Implementation

### Changes Made

**`drone-agent/src/plugins/mcp/index.ts`** (lines 399-400 added, line 403 changed):
After `cache.mountTool(toolName, registration)` succeeds, we now:
1. Call `cache.getToolDefName(toolName)` to get the short mounted name (e.g., `"searxng__web_search"`)
2. Prepend `"mcp__"` to form the canonical name (e.g., `"mcp__searxng__web_search"`)
3. Return that in the `tool` field instead of the raw internal key

**`drone-agent/test/mcp.test.ts`** (2 test assertions updated):
- `mount_tool mounts a tool with its full schema, then it is callable`: now expects `"mcp__demo__echo"` instead of `"echo"`
- `sanitizes tool names with non-[a-zA-Z0-9_-] characters when mounting`: now expects `"mcp__demo__weird_name_"` instead of `"weird name!"`

**`drone-core/src/token-estimate.ts`** (drive-by fix):
- Renamed unused variable `img` to `_img` to fix a pre-existing lint error

### Validation
- LSP diagnostics: clean
- `pnpm -r run build`: passes
- `pnpm lint`: passes
- `pnpm test`: 104 test files, 1628 tests — all pass