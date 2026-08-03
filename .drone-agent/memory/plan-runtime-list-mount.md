---
key: plan-runtime-list-mount
tags:
  - plan
  - list-mount
  - runtime
created: 2026-08-03T18:33:13.870Z
updated: 2026-08-03T18:35:50.802Z
---

# Plan: Runtime-Level List-Mount for All Tools

## Summary

Promote the ad-hoc, per-plugin list-mount pattern (currently implemented independently in file, git, lsp, swarm, and MCP plugins) to a single runtime-level mechanism. All tools are registered with the engine but start **unmounted**. Only three runtime meta-tools (`runtime__list_tools`, `runtime__mount_tool`, `runtime__unmount_tool`) are always available. The LLM must explicitly mount tools before calling them. Persona visibility filtering (`allowedTools`, `defaultHidden`) is wired into the listing so the LLM only sees tools it's allowed to use.

## Why

- Eliminates ~200 lines of duplicated boilerplate across 5 plugins
- Gives us a single place to wire persona visibility filtering into tool discovery
- Makes the tool surface area predictable and controllable
- Reduces context costs (LLM only sees mounted tools)
- Sets the stage for user-configurable auto-mount in a future pass

## Step-by-Step Plan

### Step 1: Create `ToolRegistry` class in `drone-core`

**File:** `drone-core/src/tool-registry.ts` (new)

A class that replaces both the engine's internal `Map<string, DroneToolDefinition>` and the per-plugin `ToolMountingCache` instances. Tracks mount state per tool.

```typescript
export class ToolRegistry {
  private tools = new Map<
    string,
    { definition: DroneToolDefinition; mounted: boolean }
  >();

  add(canonicalName: string, tool: DroneToolDefinition): void;
  remove(canonicalName: string): void;
  mount(canonicalName: string): DroneToolDefinition | undefined;
  unmount(canonicalName: string): void;
  isMounted(canonicalName: string): boolean;
  get(canonicalName: string): DroneToolDefinition | undefined;
  listMounted(): DroneToolDescriptor[];
  listUnmounted(
    pluginFilter?: string
  ): Array<{ name: string; description: string }>;
  listUnmountedWithSchemas(pluginFilter?: string): DroneToolDescriptor[];
  getMountedCount(): number;
  getTotalCount(): number;
  /** Returns the set of plugin IDs that have registered tools. */
  getPluginIds(): string[];
}
```

**Export** from `drone-core/src/index.ts`.

**Dependencies:** None (uses `DroneToolDefinition` and `DroneToolDescriptor` from existing types).

**Tests:** Unit test in `drone-core/test/tool-registry.test.ts` covering add, remove, mount, unmount, listMounted, listUnmounted, listUnmountedWithSchemas, plugin filtering, getPluginIds, idempotent mount/unmount.

---

### Step 2: Modify `DronePluginEngine` to use `ToolRegistry`

**File:** `drone-agent/src/runtime/plugin-engine.ts`

Replace the internal `tools = new Map<string, DroneToolDefinition>()` with `toolRegistry = new ToolRegistry()`.

Changes:

- `registerTool` callback in `registerPlugin()`: call `toolRegistry.add(canonicalName, tool)` instead of `tools.set(canonicalName, tool)`
- `getTool()`: call `toolRegistry.get(canonicalName)` instead of `tools.get(canonicalName)`
- `executeTool()`: call `toolRegistry.get(canonicalName)` then `tool.execute(input)`
- `listTools()`: call `toolRegistry.listMounted()` instead of converting the map
- `unregisterPluginToolsImpl()`: call `toolRegistry.remove()` for each matching tool
- `unregisterToolImpl()`: call `toolRegistry.remove(canonicalName)`
- `getRegisteredToolCount()`: return `toolRegistry.getTotalCount()` (keep showing total for status bar)
- Add `getMountedToolCount()`: return `toolRegistry.getMountedCount()`

**Tests:** Update `plugin-engine.test.ts` — existing tests should mostly pass since `listTools()` now returns only mounted tools. Add tests for mount/unmount lifecycle.

---

### Step 3: Register runtime meta-tools in the engine

**File:** `drone-agent/src/runtime/plugin-engine.ts`

During `initialize()`, after all plugins are registered, register and immediately mount three runtime meta-tools:

- **`runtime__list_tools({ plugin?, includeSchemas? })`** — lists unmounted tools, filtered by persona visibility
- **`runtime__mount_tool({ tool })`** — mounts by canonical name
- **`runtime__unmount_tool({ tool })`** — unmounts by canonical name

Each has closure access to `toolRegistry` and the engine's capability resolution for persona filtering.

**Tests:** Add tests for the runtime meta-tools in `plugin-engine.test.ts`.

---

### Step 4: Inject enabled plugin list into system prompt

**File:** `drone-core/src/runtime-flags.ts`

Add a `plugins` flag to the `RuntimeFlagRegistry` that lists all enabled plugin IDs. This is set by the engine during `initialize()` after all plugins are registered.

The `render()` method already handles non-`list-mount` flags as `key: value` lines. The `plugins` flag will render as:

```
plugins: exec, persona, memory, file, git, lsp, mcp, swarm, ...
```

This gives the LLM immediate awareness of which plugins are available, so it can use the `plugin` filter in `runtime__list_tools` effectively.

**File:** `drone-agent/src/runtime/plugin-engine.ts`

In `initialize()`, after all plugins are registered, set the plugins flag:

```typescript
const enabledPluginIds = Array.from(enabledPluginIds).sort().join(', ');
runtimeFlagRegistry.set('plugins', enabledPluginIds);
```

**Tests:** Update `runtime-flags.test.ts` and `plugin-engine.test.ts`.

---

### Step 5: Update `RuntimeFlagRegistry` explainer

**File:** `drone-core/src/runtime-flags.ts`

Replace the `LIST_MOUNT_EXPLAINER` constant with a unified tool management explainer:

```typescript
const TOOL_MANAGEMENT_EXPLAINER = `## Tool Management

All tools use a list-mount pattern to keep context costs low.
Call \`runtime__list_tools\` to browse available tools (optionally
filtered by plugin, e.g. \`{ "plugin": "file" }\`),
\`runtime__mount_tool\` to activate one, and
\`runtime__unmount_tool\` to deactivate it.`;

// Remove the list-mount special-casing in render()
// Just render the explainer once (no need for "Active list-mount plugins" list)
```

Also remove the `append('list-mount', ...)` calls from all plugins (file, git, lsp, swarm, mcp) since the per-plugin list-mount tracking is no longer needed.

**Tests:** Update `runtime-flags.test.ts`.

---

### Step 6: Clean up file plugin

**File:** `drone-agent/src/plugins/file.ts`

Changes:

1. Remove `ToolMountingCache` import and usage
2. Remove `FILE_TOOL_DESCRIPTIONS` constant
3. Remove `list_tools`, `mount_tool`, `unmount_tool` meta-tool registrations
4. Remove persona capability request and persona filtering logic
5. Register all 6 tools directly with `registration.registerTool()` during `register()`
6. Remove `runtime?.flags?.append('list-mount', 'file')` call

Each tool registration stays the same — just remove the `fileCache.addTool()` wrapper and register directly.

**Tests:** Update `file.test.ts` — remove tests for `list_tools`/`mount_tool`/`unmount_tool`. Existing tool tests should pass unchanged.

---

### Step 7: Clean up git plugin

**File:** `drone-agent/src/plugins/git/index.ts`

Same pattern as file plugin:

1. Remove `ToolMountingCache` import and usage
2. Remove `GIT_TOOL_DESCRIPTIONS` constant
3. Remove `list_tools`, `mount_tool`, `unmount_tool` meta-tool registrations
4. Remove persona capability request and persona filtering logic
5. Register all 11 tools directly with `registration.registerTool()` during `register()`
6. Remove `runtime?.flags?.append('list-mount', 'git')` call

**Tests:** Update `git-plugin.test.ts`.

---

### Step 8: Clean up LSP plugin

**File:** `drone-agent/src/plugins/lsp/plugin.ts`

Same pattern:

1. Remove `ToolMountingCache` import and usage
2. Remove `LSP_TOOL_DESCRIPTIONS` constant
3. Remove `list_tools`, `mount_tool`, `unmount_tool` meta-tool registrations
4. Remove persona capability request and persona filtering logic
5. Register all 10 tools directly with `registration.registerTool()` during `register()`
6. Remove `runtime?.flags?.append('list-mount', 'lsp')` call

**Tests:** Update `lsp-plugin.test.ts`.

---

### Step 9: Clean up swarm plugin

**File:** `drone-agent/src/plugins/swarm/index.ts`

Same pattern:

1. Remove `ToolMountingCache` import and usage
2. Remove `SWARM_TOOL_DESCRIPTIONS` constant
3. Remove `list_tools`, `mount_tool`, `unmount_tool` meta-tool registrations
4. Remove persona capability request and persona filtering logic
5. Register all 13 tools directly with `registration.registerTool()` during `register()`
6. Remove `runtime?.flags?.append('list-mount', 'swarm')` call

**Tests:** Update swarm-related tests.

---

### Step 10: Clean up MCP plugin

**File:** `drone-agent/src/plugins/mcp/index.ts`

This is the most complex change. The MCP plugin currently:

- Creates per-server `ToolMountingCache` instances
- Registers per-server meta-tools (`<server>__list_tools`, `<server>__mount_tool`, `<server>__unmount_tool`)
- Registers per-server resource/prompt tools (`<server>__list`, `<server>__get`)
- Registers `server_status` tool
- Mounts tools via `cache.mountTool(toolName, registration)` which calls `registration.registerTool()`

Under the new system:

1. Remove `ToolMountingCache` import and usage
2. Remove per-server `list_tools`/`mount_tool`/`unmount_tool` meta-tool registrations
3. Remove `runtime?.flags?.append('list-mount', 'mcp')` call
4. During `onPluginsLoaded`, after discovering tools from each server, register each tool directly with `registration.registerTool()` (they start unmounted)
5. Register `mcp__server_status` as a regular tool (registered directly, unmounted)
6. Register `mcp__<server>__list` and `mcp__<server>__get` as regular tools (registered directly, unmounted)
7. Update `handleToolsListChanged()` to use `registration.registerTool()` and `registration.unregisterTool()` directly instead of going through the cache

The MCP plugin no longer needs a `ToolMountingCache` at all. It just registers tools directly, and the engine's `ToolRegistry` handles mount state.

**Tests:** Update `mcp.test.ts`.

---

### Step 11: Remove `ToolMountingCache` class

**File:** `drone-core/src/tool-mounting-cache.ts` (delete)

Remove the file and its export from `drone-core/src/index.ts`.

**Tests:** Remove `tool-mounting-cache.test.ts`.

---

### Step 12: Update `conversation-service.ts`

**File:** `drone-agent/src/runtime/conversation-service.ts`

The `getLlmTools()` function already calls `engine.listTools()` which now returns only mounted tools. The persona filtering still applies on top. No changes needed here — it should just work.

**Tests:** Existing conversation-service tests should pass.

---

### Step 13: Update TUI components

**Files:** `drone-agent/src/tui/components/ListToolsBlock.tsx`, `MountToolBlock.tsx`, `UnmountToolBlock.tsx`

These components are used by the per-plugin meta-tools. Under the new system, they'll be used by the runtime meta-tools. The components don't reference plugin-specific names — they just render the tool state. They should work as-is.

However, the `ListToolsBlock` component currently expects the tool name to be a short name (like `read`), but under the new system, `runtime__list_tools` returns canonical names (like `file__read`). The component just displays the name, so this should be fine.

No changes needed to the TUI components themselves.

---

### Step 14: Update `/tools` slash command

**File:** `drone-agent/src/runtime/builtin-commands.ts`

The `/tools` command currently calls `engine.listTools()` and displays all registered tools. Under the new system, this should show mounted tools. Consider adding a `--all` flag to show all tools (mounted + unmounted).

**Tests:** Update `builtin-commands.test.ts`.

---

### Step 15: Validation

1. **LSP checks:** Run LSP on all modified files — zero errors.
2. **Typecheck:** `pnpm -r run typecheck` — zero errors.
3. **Build:** `pnpm -r run build` — zero errors.
4. **Lint:** `pnpm -r run lint` — zero errors.
5. **Tests:** `pnpm -r run test` — all tests pass.
6. **Manual smoke test:** Start a session, verify:
   - System prompt includes `plugins: exec, persona, memory, file, git, lsp, mcp, swarm, ...`
   - Only `runtime__list_tools`, `runtime__mount_tool`, `runtime__unmount_tool` are visible initially
   - `runtime__list_tools({})` returns all unmounted tools
   - `runtime__list_tools({ "plugin": "file" })` returns only file tools
   - `runtime__list_tools({ "includeSchemas": true })` includes schemas
   - `runtime__mount_tool({ "tool": "file__read" })` makes `file__read` available
   - `runtime__unmount_tool({ "tool": "file__read" })` removes it
   - Persona `allowedTools` filtering works in `runtime__list_tools`
   - MCP tools are listed and mountable

## Validation Criteria

- [ ] LSP passes on all modified files
- [ ] `pnpm -r run typecheck` passes
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
- [ ] `pnpm -r run test` passes (all tests)
- [ ] No dead code, unused imports, or fluff comments
- [ ] No file exceeds 1000 lines (split if needed)
- [ ] `ToolMountingCache` class is fully removed
- [ ] All per-plugin `__list_tools`/`__mount_tool`/`__unmount_tool` meta-tools are removed
- [ ] All `runtime?.flags?.append('list-mount', ...)` calls are removed
- [ ] Runtime meta-tools are the only always-available tools
- [ ] System prompt includes a `plugins:` line listing all enabled plugin IDs
- [ ] Persona filtering is applied in `runtime__list_tools`
