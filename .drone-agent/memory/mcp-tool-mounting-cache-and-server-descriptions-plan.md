---
key: mcp-tool-mounting-cache-and-server-descriptions-plan
tags:
  - mcp
  - planning
  - tool-loading
  - bugfix
  - architecture
created: 2026-07-13T02:22:32.478Z
updated: 2026-07-13T02:43:23.306Z
---

# MCP ToolMountingCache + Server Descriptions Plan (2026-07-12)

## Summary

Three changes to the MCP plugin:

1. **Bug fix: Multi-server MCP tools clobbering** — `listAndMountTools` calls `unregisterPluginTools('mcp')` which nukes ALL MCP tools across ALL servers. Only the last server's tools survive. Fix by introducing a `ToolMountingCache` class — one instance per server — that manages its own tool pool and mount/unmount state without touching other servers' tools.

2. **`ToolMountingCache` class in drone-core** — A reusable data structure for managing list/mount style tool collections. Stores full `DroneToolDefinition` objects (including `execute` functions). Methods: addTool, removeTool, replaceTool, mountTool, unmountTool, exportMounted, exportAvailable, listAvailable, isMounted. The MCP plugin instantiates one per server. Other plugins can reuse it for their own list/mount patterns.

3. **MCP server descriptions via LLM** — When connecting to a new MCP server, call a "clean" LLM (raw `provider.chat()`, no tools, no session) with the tool list and ask it to summarize what the server does in ≤3 sentences. The summary is included in the `__list_tools` description (NOT `__mount_tool` — the LLM browses via `__list_tools` first, so the summary belongs there to give context for which tools to mount). Cached at `~/.drone-agent/cache/mcp/server-descriptions.json` (user scope, single file, keyed by server ID). Cache is never invalidated automatically (deferred to a roadmap task).

**Correction from initial plan**: The server summary should go in `__list_tools`, not `__mount_tool`. The `__list_tools` tool is the LLM's entry point for browsing — the summary gives context for which tools to mount. The `__mount_tool` description should just describe the mounting action.

## Motivation

- The multi-server clobbering bug was introduced by the list/mount refactor (the old eager-mount code had the same `unregisterPluginTools('mcp')` pattern, but it was less visible because all tools were re-mounted in one pass). With list/mount, each server should be independent — server B connecting should not destroy server A's meta-tools.
- The `ToolMountingCache` class makes the list/mount pattern reusable and prevents this class of bug by design — each cache instance is scoped to one server, and mount/unmount operations only touch that server's tools.
- The LLM has no idea what each MCP server is for — the `__list_tools` description is generic. The server summary gives the LLM context to make better mounting decisions.

## Key Design Decisions

1. **ToolMountingCache stores full DroneToolDefinition objects** (including execute functions) — easier API for plugin writers, they just add pre-built definitions and the cache handles registration.
2. **One ToolMountingCache instance per MCP server** — solves the multi-server clobbering bug by design. No shared `mountedToolNames` set.
3. **Cache class goes in `drone-core/src/utils.ts`** (or a new file re-exported from utils) — drone-core already has runtime utility functions.
4. **No runtime sanity checks** in the cache — observe in practice first.
5. **LLM access via optional dependency on `llm` plugin** — `registration.request<DroneLlmCapability>('llm')`. If unavailable, skip description gracefully.
6. **LLM call is blocking at connection time** — before meta-tools are registered, so the description is always consistent. One-time cost, negligible compared to MCP server connection + tool listing.
7. **Cache location: `~/.drone-agent/cache/mcp/server-descriptions.json`** — user scope, single JSON file keyed by server ID: `{ serverId: { description, generatedAt } }`.
8. **Cache is never invalidated automatically** — if an entry exists, use it. Roadmap task to revisit.
9. **Server summary included in `__list_tools` description** — the LLM browses via `__list_tools` first, so the summary belongs there. The `__mount_tool` description just describes the mounting action.
10. **`__list_tools` filters through persona capability** — only show tools the persona would allow, so the LLM never sees tools it can't mount. Requires `persona` as optional dependency.
11. **`__list_tools` always includes descriptions by convention** — flat list of name + description, no categories.

## Step-by-Step Implementation Plan

### Step 1: Implement `ToolMountingCache` class

**File**: `drone-core/src/utils.ts` (or `drone-core/src/tool-mounting-cache.ts` re-exported from `utils.ts`)

```typescript
export class ToolMountingCache {
  private available = new Map<string, DroneToolDefinition>();
  private mounted = new Set<string>();

  addTool(name: string, tool: DroneToolDefinition): void {
    this.available.set(name, tool);
  }

  removeTool(name: string): void {
    this.available.delete(name);
    if (this.mounted.has(name)) {
      this.mounted.delete(name);
    }
  }

  replaceTool(name: string, tool: DroneToolDefinition): void {
    this.available.set(name, tool);
  }

  mountTool(
    name: string,
    registration: DronePluginRegistration
  ): DroneToolDefinition | undefined {
    const tool = this.available.get(name);
    if (!tool || this.mounted.has(name)) return tool;
    registration.registerTool(tool);
    this.mounted.add(name);
    return tool;
  }

  unmountTool(name: string, registration: DronePluginRegistration): void {
    if (!this.mounted.has(name)) return;
    const tool = this.available.get(name);
    if (tool) {
      registration.unregisterTool(tool.name);
    }
    this.mounted.delete(name);
  }

  exportMounted(): DroneToolDefinition[] {
    return Array.from(this.mounted)
      .map(name => this.available.get(name))
      .filter((t): t is DroneToolDefinition => t !== undefined);
  }

  exportAvailable(): DroneToolDefinition[] {
    return Array.from(this.available.values());
  }

  listAvailable(): Array<{ name: string; description: string }> {
    return Array.from(this.available.entries()).map(([name, tool]) => ({
      name,
      description: tool.description,
    }));
  }

  isMounted(name: string): boolean {
    return this.mounted.has(name);
  }
}
```

Note: The `name` parameter is the tool's internal name (e.g., `"echo"`), while `tool.name` is the full mounted name that gets registered (e.g., `"searxng__echo"`). The caller is responsible for setting `tool.name` correctly when calling `addTool`.

**Agent**: coder
**Depends on**: nothing
**Tests**: Unit tests for addTool, removeTool, mountTool, unmountTool, replaceTool, exportMounted, exportAvailable, listAvailable, isMounted. Test that mounting a tool calls `registration.registerTool`, unmounting calls `registration.unregisterTool`. Test that removing a mounted tool also unmounts it.

### Step 2: Refactor MCP plugin to use `ToolMountingCache` per server

**File**: `drone-agent/src/plugins/mcp/index.ts`

Replace the shared `mountedToolNames` set and the `serverToolCaches`/`serverAllowlists` maps with a per-server `ToolMountingCache` instance:

```typescript
const serverCaches = new Map<string, ToolMountingCache>();
```

Key changes to `listAndMountTools`:

1. **Remove** the `registration.unregisterPluginTools('mcp')` call — this was nuking ALL servers' tools.
2. **Remove** the `mountedToolNames.clear()` call — no more shared set.
3. Instead, create a new `ToolMountingCache` for this server (or clear the existing one if reconnecting).
4. For each tool returned by `connection.listTools()`, build a full `DroneToolDefinition` (with execute closure that calls `connection.callTool`) and `addTool` it to the cache.
5. Store the cache: `serverCaches.set(serverId, cache)`.
6. Store the allowlist per-server (can be a simple `Map<string, Set<string> | undefined>` or integrated into the cache).
7. Mount the meta-tools (`__list_tools`, `__mount_tool`, `__unmount_tool`) + resource/prompt tools directly via `registration.registerTool()` — these are NOT in the cache, they're plugin-level.
8. Register `server_status` directly (only once, at plugin `register()` time — remove re-registration from `listAndMountTools`).

Key changes to `__list_tools`:

- Read from `serverCaches.get(serverId)?.listAvailable()` instead of `serverToolCaches`.
- Filter through persona capability if available (only show tools the persona would allow).

Key changes to `__mount_tool`:

- Call `serverCaches.get(serverId)?.mountTool(toolName, registration)` instead of manually building and registering the tool.
- The tool definition (including execute closure) was already built at `addTool` time.
- Enforce allowlist before calling `mountTool`.

Key changes to `__unmount_tool`:

- Call `serverCaches.get(serverId)?.unmountTool(toolName, registration)`.

Key changes to `handleToolsListChanged`:

- For removed tools: `cache.removeTool(oldName)` (which also unmounts if mounted).
- For new tools: build a `DroneToolDefinition` and `cache.addTool(newName, tool)`.
- For changed tools: `cache.replaceTool(name, newTool)` (and re-mount if was mounted).
- No more `unregisterPluginTools('mcp')` — surgical per-server updates only.

Key changes to `onReconnected`:

- Clear the existing cache for this server, rebuild it from the new tool list.
- Unmount old tools, re-add new ones.
- OR: just recreate the cache from scratch (simpler).

Meta-tools: register them once per server (in `listAndMountTools`), and on reconnect, don't re-register them (they're already there). Use a per-server set to track meta-tool registration.

**Agent**: coder
**Depends on**: Step 1
**Tests**: Update integration tests — connect two mock MCP servers and verify both servers' meta-tools appear in `engine.listTools()`. This is the regression test for the clobbering bug.

### Step 3: Add LLM and persona optional dependencies to MCP plugin

**File**: `drone-agent/src/plugins/mcp/index.ts`

```typescript
metadata: {
  id: 'mcp',
  name: 'MCP',
  version: '0.1.0',
  description: 'Connects to MCP servers and mounts their tools/resources/prompts.',
  defaultEnabled: true,
  dependencies: [
    { id: 'llm', optional: true },
    { id: 'persona', optional: true },
  ],
},
```

In `register()`:

```typescript
const llmCapability = registration.request<DroneLlmCapability>('llm');
const personaCap = registration.request<DronePersonaCapability>('persona');
```

If `llmCapability` is undefined, server descriptions are skipped gracefully.
If `personaCap` is undefined, `__list_tools` shows all tools (no filtering).

**Agent**: coder
**Depends on**: nothing
**Tests**: Test that the plugin works when neither dependency is available.

### Step 4: Implement server description generation + caching

**File**: `drone-agent/src/plugins/mcp/server-description.ts` (new helper file)

**Cache file**: `~/.drone-agent/cache/mcp/server-descriptions.json`

```typescript
async function getOrCreateServerDescription(
  serverId: string,
  tools: Array<{ name: string; description?: string }>,
  llmCapability: DroneLlmCapability | undefined,
  logger: DroneLogger
): Promise<string | undefined> {
  // 1. Try cache
  const cached = await readCachedDescription(serverId);
  if (cached) return cached;

  // 2. Generate via LLM
  if (!llmCapability) return undefined;

  try {
    const provider = llmCapability.getActiveProvider();
    const model = llmCapability.getModel();
    const response = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            "You are a tool catalog summarizer. Given a list of MCP tools with names and descriptions, describe what the server does in no more than 3 sentences. Focus on the server's purpose and key capabilities.",
        },
        {
          role: 'user',
          content: JSON.stringify(
            tools.map(t => ({
              name: t.name,
              description: t.description ?? '(no description)',
            }))
          ),
        },
      ],
    });
    const description = response.message ?? '';
    if (description) {
      await writeCachedDescription(serverId, description);
    }
    return description || undefined;
  } catch (error) {
    logger.warn(
      `mcp server description generation failed for ${serverId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
```

Cache helpers:

- `readCachedDescription(serverId)`: reads `~/.drone-agent/cache/mcp/server-descriptions.json`, returns the description string for the server ID or undefined.
- `writeCachedDescription(serverId, description)`: updates the JSON file, creating the directory and file if needed.

Use `os.homedir()` to resolve the home directory, then `path.join(homedir, '.drone-agent', 'cache', 'mcp', 'server-descriptions.json')`.

**Agent**: coder
**Depends on**: Step 3
**Tests**: Test cache read, LLM call, cache write, graceful fallback.

### Step 5: Include server description in `__list_tools` description

**File**: `drone-agent/src/plugins/mcp/index.ts`

In `listAndMountTools`, after listing tools and before mounting meta-tools, call `getOrCreateServerDescription`. Then, when constructing the `__list_tools` meta-tool, include the summary:

```typescript
const serverDescription = await getOrCreateServerDescription(
  serverId,
  tools.map(t => ({ name: t.name, description: t.description })),
  llmCapability,
  registration.logger
);

const listToolsDescription = serverDescription
  ? `List all available tools for MCP server ${serverId}. Returns tool names and descriptions. Use ${serverId}__mount_tool to mount a tool before calling it.\n\nServer summary: ${serverDescription}`
  : `List all available tools for MCP server ${serverId}. Returns tool names and descriptions. Use ${serverId}__mount_tool to mount a tool before calling it.`;
```

The `__list_tools` response should also include the server summary at the top of the JSON output.

The `__mount_tool` description stays generic (just describes the mounting action, no server summary).

**Agent**: coder
**Depends on**: Step 2 (the `listAndMountTools` refactor), Step 4 (the description function)
**Tests**: Test that `__list_tools` description includes the server summary when available. Test that `__list_tools` response output includes the summary. Test fallback when no description.

### Step 6: Filter `__list_tools` through persona capability

**File**: `drone-agent/src/plugins/mcp/index.ts`

In the `__list_tools` execute handler, filter the tool list through `personaCap.getFilteredTools()` before returning:

```typescript
async () => {
  const cache = serverCaches.get(serverId);
  if (!cache) {
    return JSON.stringify({ serverId, tools: [] }, null, 2);
  }
  let tools = cache.listAvailable();
  if (personaCap) {
    // Construct DroneToolDescriptor-like objects for filtering
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
  return JSON.stringify({ serverId, toolCount: tools.length, tools }, null, 2);
};
```

**Agent**: coder
**Depends on**: Step 2, Step 3
**Tests**: Test that `__list_tools` filters out persona-hidden tools when persona is available. Test that all tools are shown when persona is not available.

### Step 7: Update tests

**File**: `drone-agent/test/mcp.test.ts`, `drone-agent/test/mcp-client.test.ts`

1. **Multi-server regression test**: Connect two mock MCP servers, verify BOTH servers' meta-tools appear in `engine.listTools()`.
2. **Server description test**: Mock the LLM capability, verify the description is generated and included in `__list_tools`. Verify cache file is written. Verify cached description is used on second connection.
3. **No LLM fallback test**: Verify `__list_tools` description is generic when no LLM is available.
4. **Persona filtering test**: Verify `__list_tools` filters out persona-hidden tools.
5. **ToolMountingCache unit tests**: Test all methods of the class.

**Agent**: coder
**Depends on**: Steps 1-6
**Tests**: Self-referential.

### Step 8: Update AGENTS.md

**File**: `AGENTS.md`

Update the "MCP Plugin (Deferred Tool Loading)" section to mention:

- The `ToolMountingCache` class in drone-core
- The server description feature (LLM-generated summary in `__list_tools`)
- The persona filtering of `__list_tools`
- The cache location

**Agent**: coder
**Depends on**: Steps 1-7
**Tests**: N/A (documentation)

### Step 9: Validation

1. `pnpm -r run build` — must pass
2. `pnpm run lint` — must pass
3. `pnpm -r run typecheck` — must pass
4. All LSP diagnostics clean
5. `pnpm -r run test` (fast suite) — must pass
6. MCP integration tests (`mcp.test.ts`) — must pass, including the new multi-server regression test

**Agent**: coder
**Depends on**: Steps 1-8

## Validation Criteria

- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm run lint` passes with zero errors
- [ ] `pnpm -r run typecheck` passes with zero errors
- [ ] All LSP diagnostics are clean
- [ ] `pnpm -r run test` (fast suite) passes with zero failures
- [ ] MCP integration tests pass, including multi-server regression test
- [ ] Two MCP servers connected simultaneously — both servers' meta-tools visible in `engine.listTools()`
- [ ] `ToolMountingCache` class is in drone-core and re-exported
- [ ] `__list_tools` description includes server summary when LLM is available
- [ ] `__list_tools` description falls back to generic when LLM is unavailable
- [ ] `__list_tools` filters out persona-hidden tools when persona is available
- [ ] Server descriptions cached at `~/.drone-agent/cache/mcp/server-descriptions.json`
- [ ] Cached descriptions are reused (no LLM call on second connection)
- [ ] AGENTS.md updated
