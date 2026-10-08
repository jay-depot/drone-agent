---
tags: [decision, mcp, tool-loading, architecture]
related:
  [
    drone-agent-mcp-client.md,
    drone-core.md,
    064-mcp-deferred-tool-loading.md,
    061-mcp-notifications-tools-list-changed.md,
  ]
---

# 065 — MCP ToolMountingCache, Server Descriptions, and Persona Filtering

**Date**: 2026-07-13

## Context

Three issues were identified after the initial deferred list/mount tool loading implementation ([064-mcp-deferred-tool-loading](064-mcp-deferred-tool-loading.md)):

### 1. Multi-server MCP tool clobbering (bug)

`listAndMountTools` called `registration.unregisterPluginTools('mcp')` which nuked ALL MCP tools across ALL servers. Only the last server's tools survived. This was a regression from the eager-mount era — the same `unregisterPluginTools('mcp')` pattern existed before, but it was less visible because all tools were re-mounted in one pass. With list/mount, each server should be independent: server B connecting should not destroy server A's meta-tools.

### 2. No server context for the LLM

The `__list_tools` description was generic: "List all available tools for MCP server X." The LLM had no idea what each MCP server was for, making it harder to decide which tools to mount. A server summary would give the LLM context for better mounting decisions.

### 3. No persona filtering of `__list_tools`

The `__list_tools` output showed all tools, but `__mount_tool` enforced the `allowedTools` allowlist. This meant the LLM could see tools it couldn't mount, causing confusion. The persona system already had `getFilteredTools()` — it should be applied to `__list_tools` output so the LLM only sees tools it is permitted to mount.

## Decision

### 1. Introduce `ToolMountingCache` class in drone-core

A reusable data structure for managing list/mount style tool collections, placed in `drone-core/src/tool-mounting-cache.ts`:

```typescript
export class ToolMountingCache {
  constructor(pluginId: string) { ... }
  addTool(name: string, tool: DroneToolDefinition): void;
  removeTool(name: string): void;
  replaceTool(name: string, tool: DroneToolDefinition): void;
  mountTool(name: string, registration: DronePluginRegistration): DroneToolDefinition | undefined;
  unmountTool(name: string, registration: DronePluginRegistration): void;
  exportMounted(): DroneToolDefinition[];
  exportAvailable(): DroneToolDefinition[];
  listAvailable(): Array<{ name: string; description: string }>;
  isMounted(name: string): boolean;
}
```

Key design:

- **One instance per MCP server** — solves the multi-server clobbering bug by design. No shared `mountedToolNames` set.
- **Stores full `DroneToolDefinition` objects** (including `execute` functions) — easier API for plugin writers.
- **Constructor takes `pluginId`** — used to construct canonical names for engine unregistration via `getCanonicalToolName(pluginId, tool.name)`.
- **Mount/unmount operations only touch that instance's tools** — preventing cross-server clobbering.

### 2. Refactor MCP plugin to use `ToolMountingCache` per server

The MCP plugin was refactored to replace the shared `mountedToolNames` set and `serverToolCaches` map with per-server `ToolMountingCache` instances:

- **Removed** `registration.unregisterPluginTools('mcp')` call — no more nuking all servers' tools.
- **Meta-tools** (`__list_tools`, `__mount_tool`, `__unmount_tool`) tracked via `metaToolNames` set to prevent re-registration on reconnect.
- **`server_status`** registered once at plugin registration time (not in `listAndMountTools`), avoiding duplicate registration errors.
- **`handleToolsListChanged`** does surgical per-server updates only — diffs old and new tool names, unmounts stale tools, adds new ones.
- **`onReconnected`** clears the old cache and rebuilds from scratch.

### 3. Add LLM and persona as optional dependencies

The MCP plugin now declares `llm` and `persona` as optional dependencies:

```typescript
dependencies: [
  { id: 'llm', optional: true },
  { id: 'persona', optional: true },
],
```

Both are requested via `registration.request()` in the `register()` function. If either is unavailable, the plugin degrades gracefully.

### 4. Server description generation via LLM

When connecting to a new MCP server, the plugin optionally calls the LLM (via the `llm` optional dependency) to generate a ≤3-sentence summary of what the server does:

- **LLM call is blocking at connection time** — before meta-tools are registered, so the description is always consistent. One-time cost, negligible compared to MCP server connection + tool listing.
- **System prompt**: "You are a tool catalog summarizer. Given a list of MCP tools with names and descriptions, describe what the server does in no more than 3 sentences. Focus on the server's purpose and key capabilities."
- **The summary is included in the `__list_tools` description** — the LLM browses via `__list_tools` first, so the summary belongs there. The `__mount_tool` description stays generic.
- **If no LLM is available**, the description falls back to a generic string.

### 5. Server description caching

Descriptions are cached at `~/.drone-agent/cache/mcp/server-descriptions.json` (user scope, single JSON file keyed by server ID):

```json
{
  "searxng": {
    "description": "A privacy-focused metasearch engine that aggregates results from multiple search sources.",
    "generatedAt": "2026-07-13T19:48:42.000Z"
  }
}
```

- **Cache is never invalidated automatically** — if an entry exists, use it. Deferred to a roadmap task.
- **Cache directory is created on first write** via `fs.mkdirSync` with `recursive: true`.

### 6. Persona filtering of `__list_tools`

When the `persona` optional dependency is available, `__list_tools` filters its output through the active persona's `allowedTools` patterns:

```typescript
if (personaCap) {
  const descriptors = tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: undefined,
    defaultHidden: false,
  }));
  const filtered = personaCap.getFilteredTools(descriptors);
  const filteredNames = new Set(filtered.map(t => t.name));
  tools = tools.filter(t => filteredNames.has(t.name));
}
```

This ensures the LLM only sees tools it is permitted to mount, preventing confusion from tools that would be rejected by `__mount_tool`.

### 7. `mountedName` includes plugin prefix

The `mountedName` returned by `__mount_tool` in its JSON response includes the `mcp__` plugin prefix (e.g., `mcp__searxng__searxng_web_search` instead of `searxng__searxng_web_search`). This is because the engine registers tools as `getCanonicalToolName('mcp', toolName)` = `mcp__<toolName>`, and the LLM uses the `mountedName` from the response to call the tool. Without this prefix, the LLM would get "Unknown tool" errors.

## Files

### New files

| File                                                | Purpose                                 |
| --------------------------------------------------- | --------------------------------------- |
| `drone-core/src/tool-mounting-cache.ts`             | `ToolMountingCache` class               |
| `drone-agent/src/plugins/mcp/server-description.ts` | Server description generation + caching |
| `drone-core/test/tool-mounting-cache.test.ts`       | 14 unit tests for `ToolMountingCache`   |

### Modified files

| File                                   | Changes                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `drone-core/src/index.ts`              | Added `ToolMountingCache` export                                                                                 |
| `drone-agent/src/plugins/mcp/index.ts` | Refactored to use `ToolMountingCache` per server; added LLM/persona deps; server descriptions; persona filtering |
| `drone-agent/test/mcp.test.ts`         | Added multi-server regression test; updated `mountedName` assertions                                             |
| `AGENTS.md`                            | Updated MCP Plugin section with new features                                                                     |

## Commits

- `105fae7` — feat: implement ToolMountingCache, server descriptions, and persona filtering for MCP plugin
- `63e26d0` — fix: __mount_tool returns full canonical name (mcp__serverId__toolName) so LLM can call it

## Related

- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — The MCP client module (updated for ToolMountingCache)
- [drone-core](../../drone-core/) — Shared types (now includes ToolMountingCache)
- [064-mcp-deferred-tool-loading](064-mcp-deferred-tool-loading.md) — Prior deferred list/mount tool loading decision
- [061-mcp-notifications-tools-list-changed](061-mcp-notifications-tools-list-changed.md) — Prior `list_changed` handling
