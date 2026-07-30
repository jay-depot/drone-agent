---
key: lsp-file-list-mount-conversion
tags:
  []
created: 2026-07-30T02:43:39.581Z
updated: 2026-07-30T02:43:39.581Z
---

# Plan: Convert LSP and File Plugin Tools to List-Mount Pattern

## Summary

Convert the LSP plugin (16 tools) and File plugin (6 tools) from eager tool registration to the list-mount pattern already established by the Git and MCP plugins. This reduces context window pressure by keeping tool schemas out of the system prompt until the LLM explicitly requests them.

## Architecture

Both plugins will follow the **Git plugin pattern** exactly:
- A single `ToolMountingCache` instance per plugin
- 3 always-registered meta-tools: `list_tools`, `mount_tool`, `unmount_tool`
- All actual tools deferred in the cache, mounted on demand
- Optional `persona` dependency for `list_tools` filtering
- Existing lifecycle hooks, prompt fragments, and render components preserved

## Steps

### Step 1: Convert LSP Plugin (`drone-agent/src/plugins/lsp/plugin.ts`)

1. Add imports: `ToolMountingCache` from `drone-core`, `DronePersonaCapability` from `drone-core`
2. Add `{ id: 'persona', optional: true }` to plugin metadata dependencies
3. Create `lspCache = new ToolMountingCache('lsp')` after server creation
4. Replace the eager registration loop with cache additions:
   ```typescript
   const tools = [createGetDiagnosticsTool(server), ...];
   for (const tool of tools) {
     lspCache.addTool(tool.name, tool);
   }
   ```
5. Register 3 meta-tools (`list_tools`, `mount_tool`, `unmount_tool`) following the git plugin pattern exactly, including persona filtering in `list_tools`
6. Keep all lifecycle hooks and prompt fragment unchanged

### Step 2: Convert File Plugin (`drone-agent/src/plugins/file.ts`)

1. Add imports: `ToolMountingCache` and `DronePersonaCapability` from `drone-core`
2. Add `{ id: 'persona', optional: true }` to plugin metadata dependencies
3. Create `fileCache = new ToolMountingCache('file')` at the start of `register`
4. Refactor each inline tool registration: create the tool object, add to cache, don't register directly
5. Register 3 meta-tools (`list_tools`, `mount_tool`, `unmount_tool`) following the git plugin pattern
6. Keep `enhanceFsError` and `__testing` export unchanged

### Step 3: Update LSP Tests

1. Add a new test file `drone-agent/test/lsp-plugin.test.ts` (modeled on `git-plugin.test.ts`) that:
   - Registers the LSP plugin via `captureRegistration()`-style helper
   - Verifies only 3 meta-tools are registered
   - Tests `list_tools` returns all 16 tool descriptions
   - Tests `mount_tool` mounts a tool and it becomes callable
   - Tests `mount_tool` rejects unknown tool names
   - Tests `unmount_tool` removes a mounted tool
2. Existing `lsp-ergonomics.test.ts` tests individual tool factories directly — these remain unchanged

### Step 4: Update File Tests

1. Refactor `drone-agent/test/file.test.ts`:
   - Update `captureRegistration()` expectations: only 3 meta-tools registered
   - Add test: "registers only 3 meta-tools (list_tools, mount_tool, unmount_tool)"
   - Add test: "list_tools returns all 6 tool descriptions"
   - Add test: "mount_tool mounts a tool and it becomes callable"
   - Add test: "mount_tool rejects an unknown tool name"
   - Add test: "unmount_tool removes a mounted tool"
   - Update existing tests to mount the required tool before calling it (e.g., mount `read` before calling `read`)
2. Keep all existing test logic — just add mount calls before tool usage

### Step 5: Verify Build and Tests

Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` to ensure everything passes.

## Validation Criteria

- [ ] `pnpm build` passes with zero errors
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run test` passes (all tests, including new ones)
- [ ] LSP diagnostics show zero errors/warnings
- [ ] LSP plugin registers only 3 meta-tools eagerly (verified by test)
- [ ] File plugin registers only 3 meta-tools eagerly (verified by test)
- [ ] All 16 LSP tools are available via `list_tools` and mountable via `mount_tool`
- [ ] All 6 file tools are available via `list_tools` and mountable via `mount_tool`
- [ ] Existing LSP ergonomics tests still pass (they test factory functions directly)
- [ ] Existing file round-trip and patch-applier tests still pass (with mount calls added)
- [ ] Diagnostics prompt fragment still renders correctly
- [ ] All lifecycle hooks (onPluginsLoaded, onBeforePrompt, onAfterToolCall, onShutdown) still fire correctly