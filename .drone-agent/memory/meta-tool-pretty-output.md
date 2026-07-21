---
key: meta-tool-pretty-output
tags:
  - plan
  - tui
  - pretty-output
  - meta-tools
created: 2026-07-21T20:52:24.502Z
updated: 2026-07-21T20:52:24.502Z
---

# Plan: meta-tool-pretty-output

## Summary

Create three reusable Ink render components — `ListToolsBlock`, `MountToolBlock`, and `UnmountToolBlock` — that replace the generic JSON-blob fallback for the `list_tools`/`mount_tool`/`unmount_tool` meta-tools across the **git**, **swarm**, and **MCP** plugins. The components live in `tui/components/` and are shared by all three plugins.

The plan also normalizes the MCP meta-tool JSON result shapes so the components see a consistent interface regardless of which plugin produced the result.

## Steps

### Step 1: Create `ListToolsBlock.tsx`

**File:** `drone-agent/src/tui/components/ListToolsBlock.tsx`

A component that renders the `list_tools` result. Expected normalized result shape:

```json
{ "toolCount": 11, "tools": [{ "name": "status", "description": "..." }, ...] }
```

Rendering:
- **Running state:** `… <name>__list_tools`
- **Done state:** `✓ <name>__list_tools — <toolCount> tool(s)` followed by an indented list of tool names with their descriptions, one per line
- **Error state:** `✗ <name>__list_tools — <error>`

Uses `tryParseJson()` to parse the result. Uses `scheme` for coloring (toolCall for running, toolResult for done, error for error).

### Step 2: Create `MountToolBlock.tsx`

**File:** `drone-agent/src/tui/components/MountToolBlock.tsx`

Expected normalized result shape:

```json
{ "success": true, "tool": "status", "description": "..." }
```
or
```json
{ "success": false, "error": "Unknown tool..." }
```

Rendering:
- **Running state:** `… <name>__mount_tool(<tool>)`
- **Done (success):** `✓ <name>__mount_tool — <tool>: <description>`
- **Done (failure):** `✗ <name>__mount_tool — <error>`
- **Error state:** `✗ <name>__mount_tool — <error>`

### Step 3: Create `UnmountToolBlock.tsx`

**File:** `drone-agent/src/tui/components/UnmountToolBlock.tsx`

Expected normalized result shape:

```json
{ "success": true, "tool": "status" }
```
or
```json
{ "success": false, "error": "..." }
```

Rendering:
- **Running state:** `… <name>__unmount_tool(<tool>)`
- **Done (success):** `✓ <name>__unmount_tool — <tool>`
- **Done (failure):** `✗ <name>__unmount_tool — <error>`
- **Error state:** `✗ <name>__unmount_tool — <error>`

### Step 4: Wire git meta-tools

**File:** `drone-agent/src/plugins/git/index.ts`

Add `renderComponent` to all three meta-tool registrations. The git meta-tools already return the normalized shapes, so this is purely adding three `renderComponent` lines.

### Step 5: Wire swarm meta-tools

**File:** `drone-agent/src/plugins/swarm/index.ts`

Same as Step 4 — the swarm meta-tools already return the same shapes as git. Add `renderComponent` to all three.

### Step 6: Normalize and wire MCP meta-tools

**File:** `drone-agent/src/plugins/mcp/index.ts`

The MCP meta-tools return slightly different shapes. Normalize in the `execute` functions inside `mountMetaTools()`:

- **`{serverId}__list_tools`**: Currently returns `{ serverId, toolCount, tools }`. Normalize to `{ toolCount, tools }`. Add `renderComponent`.
- **`{serverId}__mount_tool`**: Currently returns `{ serverId, tool, mountedName, mounted: true }` or `{ serverId, tool, mountedName, alreadyMounted: true }` or throws. Normalize to `{ success: true, tool, description }` on success, `{ success: false, error }` on failure (catch the throw). Add `renderComponent`.
- **`{serverId}__unmount_tool`**: Currently returns `{ serverId, tool, mountedName, unmounted: true }` or `{ serverId, tool, wasMounted: false }`. Normalize to `{ success: true, tool }` or `{ success: false, error }`. Add `renderComponent`.

### Step 7: Add tests

**File:** `drone-agent/test/meta-tool-blocks.test.tsx`

Test the three components with ink-testing-library, covering:

- **ListToolsBlock**: running state, done state with tools, done state with 0 tools, error state, singular "1 tool" vs plural "N tools"
- **MountToolBlock**: running state, success state, failure state, error state
- **UnmountToolBlock**: running state, success state, failure state, error state

### Step 8: Verify

- `pnpm typecheck` passes
- `pnpm lint:eslint` + `pnpm lint:prettier` passes
- `pnpm build` passes
- `pnpm test` passes (all existing tests + new tests)
- LSP diagnostics clean

## Validation Criteria

1. All LSP diagnostics pass with zero errors
2. `pnpm -r run lint` passes with zero errors
3. `pnpm -r run build` passes with zero errors
4. `pnpm -r run test` passes — all existing tests plus new meta-tool block tests
5. The three new components render correctly in all states (running/done/error) for all three plugins
6. The MCP meta-tool result normalization is backward-compatible (existing MCP tests still pass)