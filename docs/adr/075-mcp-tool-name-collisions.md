---
tags: [decision, mcp, tool-naming, collision]
related:
  [
    modules/drone-agent-mcp-client.md,
    decisions/074-mcp-spawn-timeout.md,
    decisions/076-mcp-streaming-safety-valve.md,
  ]
---

# 075: Tool-Name Sanitization Collisions (Item 13)

**Status**: Implemented (2026-07-19)

## Context

`sanitizeToolSegment` replaces any non-alphanumeric/non-underscore/non-hyphen character with `_`. This means `foo bar` and `foo.bar` both become `foo_bar`. When the second tool is added to the `ToolMountingCache`, it silently overwrites the first (via `Map.set`), and if the first was already mounted, the engine's `registerTool` throws "already registered".

## Decision

Detect collisions and append a disambiguation suffix.

### Implementation

- **`sanitizeToolSegment`** now accepts a `Set<string>` of already-used names. On collision, it appends `_1`, `_2`, etc. until unique.
- **`serverUsedNames`** map (parallel to `serverCaches`) stores per-server used name sets.
- **`listAndMountTools`** creates a fresh `usedNames` set and stores it in `serverUsedNames`.
- **`handleToolsListChanged`** retrieves the existing `usedNames` set and uses it for new tools; removed tools also have their sanitized name removed from the set (so the name slot is freed for reuse).
- **`ToolMountingCache.getToolDefName(originalName)`** returns the stored `toolDef.name` for a given internal key — this lets the `__mount_tool` and `__unmount_tool` meta-tool handlers report the actual registered name (including any collision suffix) without re-deriving it via `sanitizeToolSegment`.

### Design decisions

- **Per-server scope**: The `usedNames` set is scoped to each server's tool list, not global. This is correct because the canonical name includes the server ID (e.g., `mcp__serverA__foo_bar` vs `mcp__serverB__foo_bar`), so collisions only matter within the same server.
- **Numeric suffix**: `_1`, `_2`, etc. is simple and predictable. The LLM can easily understand `foo_bar_1` as a disambiguated version of `foo.bar`.
- **No warning needed**: The collision is handled silently — the LLM gets both tools with distinct names.

## Consequences

- Tools with colliding sanitized names are both mountable with distinct names.
- The meta-tool handlers report the actual registered name (including collision suffix) via `getToolDefName`.
- Backward compatible: tools with unique sanitized names are unaffected.

## Files Changed

- `drone-core/src/tool-mounting-cache.ts` — Added `getToolDefName()` method
- `drone-agent/src/plugins/mcp/index.ts` — Updated `sanitizeToolSegment` signature, added `serverUsedNames` map, threaded `usedNames` through `listAndMountTools` and `handleToolsListChanged`, updated meta-tool handlers to use `getToolDefName`
- `drone-agent/test/mcp.test.ts` — Added collision disambiguation test
