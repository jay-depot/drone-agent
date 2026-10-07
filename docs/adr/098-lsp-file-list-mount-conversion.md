---
tags: [decision, plugin-system, tool-reduction]
related: [decisions/064-mcp-deferred-tool-loading.md, decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md, decisions/068-tool-reduction-followup.md, decisions/069-lsp-ergonomics.md, modules/drone-agent-plugins.md, architecture/plugin-system.md]
---

# Decision 098: LSP and File Plugin List-Mount Conversion

**Summary**: Convert the LSP plugin (16 tools) and File plugin (6 tools) from eager tool registration to the list-mount pattern already established by the Git and MCP plugins.

## Context

The list-mount pattern (3 meta-tools: `list_tools`, `mount_tool`, `unmount_tool` backed by a `ToolMountingCache`) was introduced for MCP servers (decision 064) and later expanded to the Git and Swarm plugins (decision 068). The LSP and File plugins were the last remaining plugins with eager tool registration, contributing 22 tool definitions to every system prompt regardless of whether the LLM needed them.

## Decision

Convert both plugins to follow the **Git plugin pattern** exactly:

- A single `ToolMountingCache` instance per plugin
- 3 always-registered meta-tools: `list_tools`, `mount_tool`, `unmount_tool`
- All actual tools deferred in the cache, mounted on demand
- Optional `persona` dependency for `list_tools` filtering
- Existing lifecycle hooks, prompt fragments, and render components preserved

### LSP Plugin Changes

- Added `ToolMountingCache` and `DronePersonaCapability` imports
- Added `{ id: 'persona', optional: true }` to metadata dependencies
- Created `lspCache = new ToolMountingCache('lsp')`
- Replaced eager registration of 16 tools with `lspCache.addTool()` calls
- Registered 3 meta-tools with persona filtering in `list_tools`
- All lifecycle hooks (`onPluginsLoaded`, `onBeforePrompt`, `onAfterToolCall`, `onShutdown`) and diagnostics prompt fragment preserved unchanged

### File Plugin Changes

- Added `ToolMountingCache` and `DronePersonaCapability` imports
- Added `{ id: 'persona', optional: true }` to metadata dependencies
- Created `fileCache = new ToolMountingCache('file')`
- Refactored 6 inline tool registrations to `fileCache.addTool()` calls (tools were defined inline, not in separate factory files)
- Registered 3 meta-tools with persona filtering in `list_tools`
- `enhanceFsError` and `__testing` export unchanged

## Consequences

### Positive

- **Reduced context window pressure**: 22 tool schemas removed from the system prompt by default. The LLM must explicitly request tools via `__list_tools` → `__mount_tool`.
- **Consistent pattern**: All plugins now use the same list-mount pattern, making the codebase more uniform.
- **Persona filtering**: Both plugins now support persona-based tool filtering via the optional `persona` dependency.

### Negative

- **LLM must discover tools**: The LLM now needs to call `lsp__list_tools` or `file__list_tools` before using LSP or file tools, adding an extra step.
- **File plugin refactoring**: The file plugin's tools were defined inline (not in factory functions), requiring extraction of each tool object literal rather than a simple loop swap.

## Implementation

- **Branch**: `feat/lsp-file-list-mount-conversion`
- **Commit**: `a2bcc67`
- **Files changed**:
  - `drone-agent/src/plugins/lsp/plugin.ts` — LSP plugin conversion
  - `drone-agent/src/plugins/file.ts` — File plugin conversion
  - `drone-agent/test/lsp-plugin.test.ts` — New test file (5 tests)
  - `drone-agent/test/file.test.ts` — Updated with list-mount tests + mount calls before tool usage
- **Validation**: 1660 tests pass, 105 test files, all passing. Build, typecheck, lint all clean.
