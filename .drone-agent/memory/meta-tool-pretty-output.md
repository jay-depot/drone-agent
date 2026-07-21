---
key: meta-tool-pretty-output
tags:
  - plan
  - tui
  - pretty-output
  - meta-tools
  - complete
created: 2026-07-21T20:52:24.502Z
updated: 2026-07-21T21:01:45.653Z
---

# Plan: meta-tool-pretty-output

## Summary

Create three reusable Ink render components — `ListToolsBlock`, `MountToolBlock`, and `UnmountToolBlock` — that replace the generic JSON-blob fallback for the `list_tools`/`mount_tool`/`unmount_tool` meta-tools across the **git**, **swarm**, and **MCP** plugins. The components live in `tui/components/` and are shared by all three plugins.

The plan also normalizes the MCP meta-tool JSON result shapes so the components see a consistent interface regardless of which plugin produced the result.

## Status: COMPLETE

All 8 steps implemented and validated. Commit `9d5200f`.

### What was built

**Render components (3 new files in `drone-agent/src/tui/components/`):**

- `ListToolsBlock.tsx` — shows `✓ <name> — N tool(s)` header + indented tool list with descriptions
- `MountToolBlock.tsx` — shows `✓ <tool> — <description>` on success, `✗ <error>` on failure
- `UnmountToolBlock.tsx` — shows `✓ <tool>` on success, `✗ <error>` on failure

All three handle running/error/unparseable-result states gracefully.

**MCP result normalization:**

- `{serverId}__list_tools` now returns `{ toolCount, tools }` (removed `serverId`)
- `{serverId}__mount_tool` now returns `{ success, tool, description }` on success, `{ success: false, error }` on failure (instead of `{ mounted, mountedName, alreadyMounted }` or throwing)
- `{serverId}__unmount_tool` now returns `{ success, tool }` on success, `{ success: false, error }` on failure (instead of `{ unmounted, wasMounted }`)
- Added `renderComponent` parameter to MCP's `registerMetaTool` helper

**Plugin wiring:**

- `git/index.ts` — added `renderComponent` to all 3 meta-tools
- `swarm/index.ts` — added `renderComponent` to all 3 meta-tools
- `mcp/index.ts` — normalized result shapes + added `renderComponent` to all 3 meta-tools

**Tests (22 tests in `drone-agent/test/meta-tool-blocks.test.tsx`):**

- ListToolsBlock: running, done with tools, singular "1 tool", 0 tools, error, unparseable fallback
- MountToolBlock: running, success with description, success without description, failure, error, unparseable fallback
- UnmountToolBlock: running, success, failure, error, unparseable fallback

**MCP test updates:**

- Updated 5 test assertions in `mcp.test.ts` to match normalized shapes

### Validation

- `pnpm typecheck` ✅
- `pnpm lint` (prettier) ✅
- `pnpm build` ✅
- `pnpm test` — 103 test files, 1591 tests, all passing ✅
- LSP diagnostics clean ✅
