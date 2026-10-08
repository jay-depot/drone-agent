---
tags: [decision, tui, rendering, mcp, git, swarm]
related:
  [
    078-pretty-tool-output.md,
    079-pretty-tool-output-phase-2.md,
    080-subagent-dispatch-pretty-output.md,
    modules/drone-agent-tui.md,
    modules/drone-agent-mcp-client.md,
    decisions/064-mcp-deferred-tool-loading.md,
    decisions/068-tool-reduction-followup.md,
  ]
---

# ADR 081: Meta-Tool Pretty Output (List/Mount/Unmount)

**Status**: Implemented (commit `9d5200f`, 2026-07-21)

## Context

The `list_tools`/`mount_tool`/`unmount_tool` meta-tools across the **git**, **swarm**, and **MCP** plugins all fell back to the generic JSON-blob `ToolCallProgress` display. These meta-tools have consistent semantics (listing, mounting, unmounting tools) and should share a consistent visual presentation.

Additionally, the MCP meta-tools returned inconsistent result shapes — some used `{ mounted, mountedName, alreadyMounted }`, others threw errors as strings, etc.

## Decision

Create three reusable Ink render components — `ListToolsBlock`, `MountToolBlock`, and `UnmountToolBlock` — that replace the generic JSON-blob fallback for all three plugins. The components live in `tui/components/` and are shared by all three plugins.

Normalize the MCP meta-tool JSON result shapes so the components see a consistent interface regardless of which plugin produced the result.

### Render Components

| Component          | Behavior                                                             |
| ------------------ | -------------------------------------------------------------------- |
| `ListToolsBlock`   | `✓ <name> — N tool(s)` header + indented tool list with descriptions |
| `MountToolBlock`   | `✓ <tool> — <description>` on success, `✗ <error>` on failure        |
| `UnmountToolBlock` | `✓ <tool>` on success, `✗ <error>` on failure                        |

All three handle running/error/unparseable-result states gracefully.

### MCP Result Normalization

- `{serverId}__list_tools` now returns `{ toolCount, tools }` (removed `serverId`)
- `{serverId}__mount_tool` now returns `{ success, tool, description }` on success, `{ success: false, error }` on failure (instead of `{ mounted, mountedName, alreadyMounted }` or throwing)
- `{serverId}__unmount_tool` now returns `{ success, tool }` on success, `{ success: false, error }` on failure (instead of `{ unmounted, wasMounted }`)
- Added `renderComponent` parameter to MCP's `registerMetaTool` helper

### Plugin Wiring

- `git/index.ts` — added `renderComponent` to all 3 meta-tools
- `swarm/index.ts` — added `renderComponent` to all 3 meta-tools
- `mcp/index.ts` — normalized result shapes + added `renderComponent` to all 3 meta-tools

### Tests

22 tests in `test/meta-tool-blocks.test.tsx` covering:

- ListToolsBlock: running, done with tools, singular "1 tool", 0 tools, error, unparseable fallback
- MountToolBlock: running, success with description, success without description, failure, error, unparseable fallback
- UnmountToolBlock: running, success, failure, error, unparseable fallback

5 MCP test assertions updated in `mcp.test.ts` to match normalized shapes.

## Consequences

### Positive

- Consistent visual presentation for list/mount/unmount across all three plugins
- MCP result shapes normalized (no more `{ mounted, mountedName, alreadyMounted }` confusion)
- Reusable components reduce duplication

### Negative

- MCP result shape change required updating 5 test assertions
- `registerMetaTool` helper gained a `renderComponent` parameter (slightly more complex API)

## Related

- [078-pretty-tool-output](078-pretty-tool-output.md) — Phase 1: 7 core tools
- [079-pretty-tool-output-phase-2](079-pretty-tool-output-phase-2.md) — Phase 2: 12 more tools
- [080-subagent-dispatch-pretty-output](080-subagent-dispatch-pretty-output.md) — Subagent dispatch TUI rendering
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI module documentation
- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — MCP client module
- [064-mcp-deferred-tool-loading](064-mcp-deferred-tool-loading.md) — The list/mount pattern for MCP
- [068-tool-reduction-followup](068-tool-reduction-followup.md) — Git and swarm list/mount pattern
