---
key: mcp-list-mount-plan
tags:
  - mcp
  - planning
  - tool-loading
  - architecture
created: 2026-07-12T20:52:39.167Z
updated: 2026-07-12T20:52:39.167Z
---

# MCP List/Mount Deferred Tool Loading Plan (2026-07-12)

## Summary

Replace the current "eagerly mount all MCP tools at connection time" approach with a **list/mount deferred loading pattern**. When an MCP server connects, its tools are NOT mounted as native LLM tool definitions. Instead, two meta-tools are mounted per server: `__list_tools` (returns tool names + descriptions) and `__mount_tool` (dynamically registers a specific tool with its full schema). The LLM browses available tools, mounts the ones it needs, and then uses them as native tools with full schemas.

This also fixes the `discoveredToolCount` layering violation (gap analysis item 9): `client.ts` and `index.ts` both write the same field redundantly, and the `index.ts` write should be removed.

**Motivation**: Real-world MCP servers like Datadog (142 tools, ~70K tokens), MCP_DOCKER (135 tools, ~126K tokens), and Cloudflare (~1.17M tokens) can consume most of the context window with tool definitions alone. Tool selection accuracy drops from 95% with 4 tools to 71% with 46 tools. The current approach of mounting every tool eagerly is unbounded — context cost grows linearly with server tool count. The list/mount pattern bounds context cost to 2 meta-tools per server regardless of how many tools the server offers.

**Long-term vision**: If this works well for MCP, the same pattern may be expanded globally to all tools (not just MCP). This plan is a stepping stone toward that vision.

## Scope

- **In scope**: All MCP servers (regardless of tool count), the `discoveredToolCount` refactor, engine changes for single-tool unregister
- **Out of scope**: Auto-eviction of mounted tools, tool search/keyword filtering, server-side tag filtering, other open MCP gap items (4, 7, 10-14), resources/prompts/resource-templates (they stay eagerly mounted — the context cost problem is specifically about tool definitions)

## Key Design Decisions

1. **All MCP servers use list/mount** — no threshold, no "monster vs normal" split. Any reasonable threshold would be crossed frequently enough that transition logic isn't worth the complexity.
2. **`__list_tools` returns names + descriptions only** (no schemas) — the LLM mounts somewhat blind, then gets the full schema via `__mount_tool`. This keeps the list response small even for monster servers.
3. **No auto-eviction** — overmounting is no worse than today's status quo, only for the session. The LLM is not trusted to self-evict (it's not aware of its own context usage, and the more tools mounted, the less likely it remembers an unmount tool exists).
4. **`notifications/tools/list_changed` unmounts stale tools** — when the server signals its tool list changed, we re-list, unmount any tools that no longer exist on the server, and update the cached tool metadata.
5. **Resources, prompts, and resource templates stay eagerly mounted** — they are not tools and don't have the same context cost profile.
6. **The allowlist still applies** — if `allowedTools` is configured for a server, only allowlisted tools can be mounted via `__mount_tool`. The `__list_tools` response can still show all tools (so the LLM knows what exists), but `__mount_tool` rejects non-allowlisted tools.

## Architecture Changes

### Current Flow
```
Server connects → listAndMountTools() → unregister all MCP tools → list tools →
  filter by allowlist → mount ALL tools as native definitions → mount resource/prompt tools →
  register server_status
```

### New Flow
```
Server connects → listAndMountTools() → unregister all MCP tools → list tools →
  cache tool metadata (name, description, inputSchema) in a per-server Map →
  mount __list_tools meta-tool → mount __mount_tool meta-tool →
  mount __unmount_tool meta-tool → mount resource/prompt/template tools (still eager) →
  register server_status → (optionally pre-mount allowlisted tools if allowlist is small)
```

## Step-by-Step Implementation Plan

### Step 1: Add `unregisterTool` to the plugin engine

**File**: `drone-agent/src/runtime/plugin-engine.ts`
**Also**: `drone-core/src/plugin-system.ts` (type definition)

The engine currently only has `unregisterPluginTools(pluginId)` — bulk removal. We need `unregisterTool(canonicalName: string)` for removing individual dynamically-mounted tools.

**In `drone-core/src/plugin-system.ts`**, add to `DronePluginRegistration`:
```ts
/**
 * Remove a single tool by its canonical name (pluginId__toolName).
 * Used for unmounting individual dynamically-mounted tools (e.g. MCP
 * tools mounted via __mount_tool that are no longer needed or whose
 * server no longer lists them).
 */
unregisterTool: (canonicalName: string) => void;
```

**In `drone-agent/src/runtime/plugin-engine.ts`**, add the implementation:
```ts
function unregisterToolImpl(canonicalName: string): void {
  if (tools.has(canonicalName)) {
    tools.delete(canonicalName);
    // Also remove from the plugin's own tool list
    for (const registered of registeredPlugins) {
      const idx = registered.tools.findIndex(
        (t: DroneToolDefinition) =>
          getCanonicalToolName(registered.plugin.metadata.id, t.name) ===
          canonicalName
      );
      if (idx >= 0) {
        registered.tools.splice(idx, 1);
        break;
      }
    }
  }
}
```

Wire it into both registration objects (the one in `registerPlugin` at ~line 499 and the external one at ~line 632):
```ts
unregisterTool: (canonicalName: string) => {
  unregisterToolImpl(canonicalName);
},
```

Also add to the `DronePluginEngine` interface type (~line 101):
```ts
unregisterTool: (canonicalName: string) => void;
```

**Agent**: coder
**Depends on**: nothing
**Tests**: Add a test in `drone-agent/test/plugin-engine.test.ts` (or create one if it doesn't exist) that registers a tool, unregisters it by name, and verifies it's gone from `listTools()` and that other tools remain.

### Step 2: Add per-server tool metadata cache to the MCP plugin

**File**: `drone-agent/src/plugins/mcp/index.ts`

Add a `Map<string, McpToolMeta>` per server to cache the full tool metadata (name, description, inputSchema) returned by `listTools()`. This cache is the "menu" that `__list_tools` reads from and `__mount_tool` uses to register tools.

```ts
// Per-server cached tool metadata: serverId → toolName → McpToolMeta
const serverToolCaches = new Map<string, Map<string, McpToolMeta>>();
```

Add a helper to get/set/clear the cache for a server.

**Agent**: coder
**Depends on**: nothing
**Tests**: Unit test the cache helpers.

### Step 3: Refactor `discoveredToolCount` (fix item 9)

**File**: `drone-agent/src/plugins/mcp/index.ts`, `drone-agent/src/plugins/mcp/client.ts`

1. **Remove the redundant write at `index.ts:305`**:
   ```ts
   // DELETE THIS LINE:
   connection.state.discoveredToolCount = tools.length;
   ```
   The client (`client.ts:1153`) already sets `state.discoveredToolCount = toolsResult.items.length` correctly.

2. **Update `mountedToolCount`** in `index.ts` to reflect only actually-mounted tools (via `__mount_tool`), not all discovered tools. After the refactor, `discoveredToolCount` = tools discovered from server, `mountedToolCount` = tools the LLM has chosen to mount. These will diverge.

3. **Update the test at `mcp-client.test.ts:218`**: Change the comment from `// CURRENT behavior: discoveredToolCount reflects truncated page count.` to a positive description: `// discoveredToolCount reflects the number of tools fetched from the server.`

**Agent**: coder
**Depends on**: Step 2 (the cache is populated in the same flow)
**Tests**: Update existing `mcp-client.test.ts` test, add a test verifying `discoveredToolCount` is set by the client and not overwritten by the plugin.

### Step 4: Implement `__list_tools` meta-tool

**File**: `drone-agent/src/plugins/mcp/index.ts`

Replace the current `mountMcpTools()` (which mounts all tools eagerly) with a function that mounts the `__list_tools` meta-tool.

`__list_tools` returns a JSON array of `{ name, description }` for all tools in the server's cached tool metadata. No schemas are included — the LLM uses descriptions to decide what to mount.

```ts
registerMountedTool(
  `${serverId}__list_tools`,
  `List all available tools for MCP server ${serverId}. Returns tool names and descriptions. Use ${serverId}__mount_tool to mount a tool before calling it.`,
  { type: 'object', additionalProperties: false },
  async () => {
    const cache = serverToolCaches.get(serverId);
    if (!cache) {
      return JSON.stringify({ serverId, tools: [] }, null, 2);
    }
    const tools = Array.from(cache.values()).map(t => ({
      name: t.name,
      description: t.description ?? `(no description)`,
    }));
    return JSON.stringify({ serverId, toolCount: tools.length, tools }, null, 2);
  }
);
```

**Agent**: coder
**Depends on**: Step 2 (uses the cache), Step 3 (discoveredToolCount is now correct)
**Tests**: Test that `__list_tools` returns names + descriptions without schemas. Test with empty cache, small cache, and large cache.

### Step 5: Implement `__mount_tool` meta-tool

**File**: `drone-agent/src/plugins/mcp/index.ts`

`__mount_tool` takes a tool name, looks it up in the server's tool cache, and registers it as a native tool definition with its full input schema. The mounted tool's execute function calls `connection.callTool(toolName, input)`.

```ts
registerMountedTool(
  `${serverId}__mount_tool`,
  `Mount a specific tool from MCP server ${serverId} so it becomes available as a native tool. Use ${serverId}__list_tools to see available tools. Once mounted, the tool will appear in your tool list with its full schema.`,
  {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: `The name of the tool to mount (as shown by ${serverId}__list_tools).`,
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  async input => {
    const toolName = input.tool;
    const cache = serverToolCaches.get(serverId);
    if (!cache) {
      throw new Error(`MCP server ${serverId} has no tool cache.`);
    }
    const toolMeta = cache.get(toolName);
    if (!toolMeta) {
      const available = Array.from(cache.keys()).join(', ');
      throw new Error(
        `Tool '${toolName}' not found on MCP server ${serverId}. Available tools: ${available}`
      );
    }

    // Enforce allowlist if configured
    if (allowedToolSet && !allowedToolSet.has(toolName)) {
      throw new Error(
        `Tool '${toolName}' is not in the allowedTools list for MCP server ${serverId}.`
      );
    }

    const mountedName = `${serverId}__${sanitizeToolSegment(toolMeta.name)}`;
    if (mountedToolNames.has(mountedName)) {
      return JSON.stringify(
        { serverId, tool: toolName, mountedName, alreadyMounted: true },
        null,
        2
      );
    }

    registerMountedTool(
      mountedName,
      toolMeta.description ?? `MCP tool ${toolMeta.name} from server ${serverId}.`,
      toDroneInputSchema(toolMeta.inputSchema),
      async toolInput => {
        const result = await connection.callTool(toolMeta.name, toolInput);
        return JSON.stringify({ serverId, tool: toolMeta.name, result }, null, 2);
      }
    );

    // Update mounted tool count
    connection.state.mountedToolCount = mountedToolNames.size;
    setServerState(connection.state);

    return JSON.stringify(
      { serverId, tool: toolName, mountedName, mounted: true },
      null,
      2
    );
  }
);
```

Note: `allowedToolSet` needs to be accessible here — it should be stored per-server (e.g. in a `Map<string, Set<string> | undefined>` alongside the tool cache).

**Agent**: coder
**Depends on**: Step 1 (uses `registerTool` which already works), Step 2 (uses the cache), Step 4 (mounted alongside `__list_tools`)
**Tests**: Test mounting a tool by name, test mounting a non-existent tool (error), test mounting when allowlist is configured (allowed + blocked), test mounting an already-mounted tool (idempotent), test that the mounted tool appears in `engine.listTools()` and is callable.

### Step 6: Implement `__unmount_tool` meta-tool

**File**: `drone-agent/src/plugins/mcp/index.ts`

`__unmount_tool` removes a previously mounted tool by name. Uses the new `unregisterTool` engine method from Step 1.

```ts
registerMountedTool(
  `${serverId}__unmount_tool`,
  `Unmount a previously mounted tool from MCP server ${serverId}. This removes the tool from your active tool list to reduce clutter.`,
  {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: `The name of the tool to unmount (as shown by ${serverId}__list_tools, not the mounted name).`,
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  async input => {
    const toolName = input.tool;
    const mountedName = `${serverId}__${sanitizeToolSegment(toolName)}`;
    if (!mountedToolNames.has(mountedName)) {
      return JSON.stringify(
        { serverId, tool: toolName, wasMounted: false },
        null,
        2
      );
    }
    registration.unregisterTool(`mcp__${mountedName}`);
    mountedToolNames.delete(mountedName);
    connection.state.mountedToolCount = mountedToolNames.size;
    setServerState(connection.state);
    return JSON.stringify(
      { serverId, tool: toolName, mountedName, unmounted: true },
      null,
      2
    );
  }
);
```

Note: The canonical name format is `pluginId__toolName`, so the full canonical name is `mcp__${mountedName}`. Verify the exact format by checking `getCanonicalToolName` in the engine.

**Agent**: coder
**Depends on**: Step 1 (uses `unregisterTool`), Step 5 (unmounts tools mounted by `__mount_tool`)
**Tests**: Test unmounting a mounted tool, test unmounting a non-mounted tool (idempotent/no-op), test that the unmounted tool is gone from `engine.listTools()`, test that meta-tools (`__list_tools`, `__mount_tool`, `__unmount_tool`) cannot be unmounted.

### Step 7: Refactor `listAndMountTools` to the new flow

**File**: `drone-agent/src/plugins/mcp/index.ts`

Rewrite `listAndMountTools` to:
1. Unregister all MCP plugin tools (existing behavior — clears everything)
2. Clear `mountedToolNames`
3. List tools from the server via `connection.listTools()`
4. Populate the per-server tool cache with full metadata
5. Store the allowlist for the server
6. Mount `__list_tools`, `__mount_tool`, `__unmount_tool` meta-tools
7. Mount resource/prompt/template tools (still eager — unchanged)
8. Re-register `server_status`
9. Update `discoveredToolCount` (from cache size), `mountedToolCount` (0 initially or from allowlist pre-mount), `filteredToolCount` (if allowlist configured)
10. Log the new state

Remove the old `mountMcpTools()` function — its logic is now inside `__mount_tool`'s execute handler.

The `filteredToolCount` field should now represent the count of tools excluded by the allowlist (i.e. `discoveredToolCount - allowlistedCount`), not `discoveredToolCount - mountedToolCount` as before.

**Agent**: coder
**Depends on**: Steps 2-6
**Tests**: Integration test — connect a mock MCP server, verify only meta-tools are mounted initially, verify `discoveredToolCount` is correct, verify no individual tools are in `engine.listTools()`.

### Step 8: Handle `notifications/tools/list_changed` with unmount of stale tools

**File**: `drone-agent/src/plugins/mcp/index.ts`

Update the `onNotification` handler for `notifications/tools/list_changed`:

1. Capture the set of currently-mounted tool names for this server
2. Re-list tools from the server
3. Update the per-server tool cache
4. For each currently-mounted tool: if it no longer exists in the cache, unregister it via `unregisterTool` and remove from `mountedToolNames`
5. Re-mount the meta-tools (`__list_tools`, `__mount_tool`, `__unmount_tool`) — they were unregistered by the bulk `unregisterPluginTools` if we use that, OR just leave them if we're more surgical
6. Update `discoveredToolCount` and `mountedToolCount`

Consider: should we use `unregisterPluginTools('mcp')` + full re-mount of meta-tools (simpler but nukes all servers' tools), or be surgical and only update the one server's cache + unmount stale tools? The surgical approach is better since multiple MCP servers may be connected.

**Surgical approach** (recommended):
- Don't call `unregisterPluginTools`
- Re-list tools for this server only
- Diff old cache vs new list: remove stale entries from cache, add new entries to cache
- For each stale entry that was mounted: `unregisterTool`, remove from `mountedToolNames`
- Update `discoveredToolCount`, `mountedToolCount`
- Meta-tools don't need re-registration (they weren't removed)

**Agent**: coder
**Depends on**: Step 7 (the new flow), Step 1 (uses `unregisterTool`)
**Tests**: Test that when a server removes a tool, it's unmounted from the engine. Test that when a server adds a tool, it appears in `__list_tools` output. Test that mounted tools not affected by the change remain mounted.

### Step 9: Update `server_status` output

**File**: `drone-agent/src/plugins/mcp/index.ts`

The `server_status` tool dumps `DroneMcpServerState` as JSON. Ensure the output clearly shows:
- `discoveredToolCount` — total tools discovered from server
- `mountedToolCount` — tools currently mounted (via `__mount_tool`)
- `filteredToolCount` — tools excluded by allowlist
- `toolsListTruncated` — whether the list was truncated by pagination limits

Also update the log line at mount time to reflect the new state:
```ts
registration.logger.info(
  `mcp server ${logMessage}: ${serverId} (discovered ${connection.state.discoveredToolCount} tool(s), mounted ${connection.state.mountedToolCount})`
);
```

**Agent**: coder
**Depends on**: Step 7
**Tests**: Test that `server_status` output includes the correct counts after connecting and after mounting tools.

### Step 10: Update existing tests for the new behavior

**File**: `drone-agent/test/mcp-client.test.ts`, `drone-agent/test/mcp.test.ts`

1. **`mcp-client.test.ts`**: Update the `discoveredToolCount` test (item 9 fix from Step 3). The client-level test should still pass — `client.ts` still sets `discoveredToolCount` to `items.length`.

2. **`mcp.test.ts`** (slow integration): Update any tests that assert individual MCP tools are mounted after connection. They should now assert that only meta-tools are mounted, and that `__mount_tool` is needed to get individual tools.

3. Add new tests for the list/mount flow:
   - Connect to mock server → verify only `__list_tools`, `__mount_tool`, `__unmount_tool`, resource/prompt tools, and `server_status` are mounted
   - Call `__list_tools` → verify names + descriptions returned, no schemas
   - Call `__mount_tool("echo")` → verify `serverId__echo` appears in tool list with full schema
   - Call the mounted tool → verify it proxies to `connection.callTool`
   - Call `__unmount_tool("echo")` → verify `serverId__echo` is gone
   - Test with allowlist: `__list_tools` shows all, `__mount_tool` rejects non-allowlisted
   - Test `notifications/tools/list_changed`: stale tools unmounted, new tools appear in list

**Agent**: coder or tester
**Depends on**: Steps 1-9
**Tests**: Self-referential — this step IS the tests.

### Step 11: Update AGENTS.md

**File**: `AGENTS.md`

Update the MCP plugin section to document the list/mount pattern:
- Note that MCP tools are not mounted eagerly — they use `__list_tools` + `__mount_tool` + `__unmount_tool`
- Note that resources, prompts, and resource templates are still mounted eagerly
- Note the long-term vision of expanding this pattern globally

**Agent**: coder
**Depends on**: Steps 1-10
**Tests**: N/A (documentation)

### Step 12: Validation

Run all validation checks:

1. `pnpm -r run build` — must pass with zero errors
2. `pnpm -r run lint` — must pass with zero errors (remember to re-read files after prettier reformats)
3. `pnpm -r run typecheck` — must pass with zero errors
4. All LSP diagnostics must be clean (no errors, no warnings in files we touched)
5. `pnpm -r run test` (fast suite) — must pass with zero failures
6. `pnpm -r run test:integration` (slow suite, includes `mcp.test.ts`) — must pass

**Agent**: coder
**Depends on**: Steps 1-11

## Validation Criteria

- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run typecheck` passes with zero errors
- [ ] All LSP diagnostics are clean (no errors or warnings in touched files)
- [ ] `pnpm -r run test` (fast suite) passes with zero failures
- [ ] `pnpm -r run test:integration` (slow suite) passes with zero failures
- [ ] No individual MCP tools are mounted eagerly at connection time — only meta-tools
- [ ] `__list_tools` returns names + descriptions without schemas
- [ ] `__mount_tool` registers a tool with its full schema, callable natively
- [ ] `__unmount_tool` removes a mounted tool from the engine
- [ ] `notifications/tools/list_changed` unmounts stale tools and updates the cache
- [ ] `discoveredToolCount` is set only by the client, not overwritten by the plugin
- [ ] Allowlist is enforced by `__mount_tool` (rejected tools throw an error)
- [ ] `server_status` reports correct discovered/mounted/filtered counts
- [ ] AGENTS.md documents the new list/mount pattern