---
tags: [decision, plugin-system, tool-reduction, runtime]
related:
  [
    decisions/064-mcp-deferred-tool-loading.md,
    decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md,
    decisions/068-tool-reduction-followup.md,
    decisions/098-lsp-file-list-mount-conversion.md,
    decisions/100-list-mount-improvements.md,
    decisions/101-systemprompt-runtime-flags.md,
    architecture/plugin-system.md,
    modules/drone-core.md,
    modules/drone-agent-mcp-client.md,
  ]
---

# Decision 105: Runtime-Level List-Mount for All Tools

**Summary**: Promoted the ad-hoc, per-plugin list-mount pattern (independently implemented in file, git, lsp, swarm, and MCP plugins) to a single runtime-level mechanism. All tools start unmounted. Only three runtime meta-tools (`runtime__list_tools`, `runtime__mount_tool`, `runtime__unmount_tool`) are always available. The LLM must explicitly mount tools before calling them.

## Context

Five plugins (file, git, lsp, swarm, MCP) independently implemented the list-mount pattern, each with their own `ToolMountingCache`, duplicated `list_tools`/`mount_tool`/`unmount_tool` meta-tools, and duplicated persona filtering logic. This created:

- **~200 lines of duplicated boilerplate** across 5 plugins
- **Inconsistent behavior** — each plugin had slightly different error messages, response formats, and persona filtering
- **No unified visibility filtering** — persona `allowedTools` patterns were applied in `getLlmTools()` (conversation-service) but not in the plugin-level `list_tools` responses
- **MCP per-server meta-tools** — each MCP server got its own `__list_tools`/`__mount_tool`/`__unmount_tool`, creating a confusing namespace

## Decision

### 1. `ToolRegistry` Class (drone-core)

A new `ToolRegistry` class in `drone-core/src/tool-registry.ts` replaces both the engine's internal `Map<string, DroneToolDefinition>` and the per-plugin `ToolMountingCache` instances. It tracks mount state per tool:

```typescript
export class ToolRegistry {
  add(canonicalName, tool)       // Register a tool (unmounted)
  remove(canonicalName)           // Remove a tool
  mount(canonicalName)            // Mount a tool (visible to LLM)
  unmount(canonicalName)          // Unmount a tool (hidden from LLM)
  isMounted(canonicalName)        // Check mount state
  get(canonicalName)              // Get tool definition
  listMounted()                   // List only mounted tools
  listAll()                       // List all tools (mounted + unmounted)
  listUnmounted(pluginFilter?)    // List unmounted tools, optionally filtered by plugin
  listUnmountedWithSchemas(...)   // Same with full schemas
  getMountedCount() / getTotalCount()
  getPluginIds()                  // Unique plugin IDs with registered tools
  removeByPrefix(prefix)          // Remove all tools for a plugin
}
```

### 2. Engine Uses `ToolRegistry`

The `DronePluginEngine` swapped its internal `Map<string, DroneToolDefinition>` for `ToolRegistry`. Key changes:

- `registerTool` → `toolRegistry.add(canonicalName, tool)`
- `listTools()` → `toolRegistry.listMounted()` (only mounted tools)
- `getTool()` / `executeTool()` → `toolRegistry.get()`
- `unregisterPluginTools()` → `toolRegistry.removeByPrefix()`
- `unregisterTool()` → `toolRegistry.remove()`
- Added `getMountedToolCount()` and `listAllTools()` to the engine interface

### 3. Three Runtime Meta-Tools (Always Available)

Registered by the engine itself during `initialize()`, after all plugins are registered:

- **`runtime__list_tools({ plugin?, includeSchemas? })`** — Lists unmounted tools, filtered by persona visibility. Query by plugin (e.g., `{ "plugin": "file" }`) or omit for all. Optional `includeSchemas` flag (default false).
- **`runtime__mount_tool({ tool })`** — Mounts by canonical name (e.g., `"file__read"`).
- **`runtime__unmount_tool({ tool })`** — Unmounts by canonical name.

### 4. Plugin List in System Prompt

The engine injects `plugins: exec, persona, memory, file, git, lsp, mcp, swarm, ...` into the system prompt via `RuntimeFlagRegistry`, so the LLM knows what plugins are available to filter by.

### 5. Plugin Cleanup

**File, git, lsp, swarm:** Removed `ToolMountingCache`, `FILE_TOOL_DESCRIPTIONS`/`GIT_TOOL_DESCRIPTIONS`/`LSP_TOOL_DESCRIPTIONS`/`SWARM_TOOL_DESCRIPTIONS` constants, all three meta-tools, persona filtering in `list_tools`, and `runtime?.flags?.append('list-mount', ...)` calls. Tools are now registered directly with `registration.registerTool()`.

**MCP:** Most complex change. Removed:

- `ToolMountingCache` import and usage (replaced with `Map<string, { definition, mounted }>`)
- Per-server `list_tools`/`mount_tool`/`unmount_tool` meta-tools (runtime handles this now)
- `registerMetaTool` function
- `mountMetaTools` function
- `runtime?.flags?.append('list-mount', 'mcp')` call

Changed:

- `mountResourcePromptTools` → `registerResourcePromptTools` — registers `mcp__<server>__list` and `mcp__<server>__get` as regular unmounted tools
- MCP tools are now registered with the engine (unmounted) via `registration.registerTool(toolDef)` so they appear in `runtime__list_tools`
- `mcp__server_status` is a regular unmounted tool (no longer auto-mounted)

### 6. `DronePluginRegistration` Interface Additions

Added `mountTool(canonicalName)` and `unmountTool(canonicalName)` methods for plugins that need to manage their own tool lifecycle (e.g., MCP plugin's meta-tools that need to be mounted immediately).

### 7. `/tools` Slash Command Fix

- `/tools` shows mounted tools (filtered by persona)
- `/tools --all` now uses `listAllTools()` to show all registered tools (mounted + unmounted), including `runtime__*` meta-tools
- Added `listAllTools` and `getRegisteredToolCount` to `DroneSlashCommandContext.engine` type

### 8. `ToolMountingCache` Removed

The `ToolMountingCache` class (`drone-core/src/tool-mounting-cache.ts`) and its test file were deleted. The MCP plugin now uses a simple `Map<string, { definition, mounted }>` internally.

## Consequences

### Positive

- **~200 lines of duplicated boilerplate eliminated** across 5 plugins
- **Single place for persona visibility filtering** — `runtime__list_tools` applies persona `allowedTools` patterns
- **Predictable tool surface** — LLM always sees exactly 3 tools initially, must explicitly mount what it needs
- **Reduced context costs** — LLM only sees mounted tools in its tool list
- **MCP namespace cleaned up** — No more per-server `__list_tools`/`__mount_tool`/`__unmount_tool` cluttering the tool list
- **`/tools --all` now works correctly** — shows all registered tools including `runtime__*` meta-tools
- **Sets the stage** for user-configurable auto-mount in a future pass

### Negative

- **MCP plugin complexity** — The MCP plugin's internal tool tracking (per-server maps, mount state, allowlists) is now handled with raw maps instead of `ToolMountingCache`, making the plugin slightly more complex internally
- **Test maintenance** — All tests that checked `listTools()` needed updating to mount tools first via `runtime__mount_tool`
- **Backward compatibility** — Existing macros or workflows that call `file__mount_tool`/`git__mount_tool` etc. will break (acceptable since we're pre-release)

## Implementation

- **Branch**: `feat/list-mount-alll-the-things`
- **Commits**: `7a5e058` (main implementation), `f9a52b0` (MCP cleanup + /tools fix)
- **Files changed**: 38 total (29 in first commit, 9 in second)
- **New files**: `drone-core/src/tool-registry.ts`, `drone-core/test/tool-registry.test.ts`
- **Deleted files**: `drone-core/src/tool-mounting-cache.ts`, `drone-core/test/tool-mounting-cache.test.ts`
- **Validation**: 108 test files, 1687 tests pass. LSP, typecheck, build, lint all clean.
