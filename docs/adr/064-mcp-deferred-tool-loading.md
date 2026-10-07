---
tags: [decision, mcp, tool-loading, architecture]
related: [drone-agent-mcp-client.md, plugin-system.md, DronePlugin.md, 061-mcp-notifications-tools-list-changed.md]
---

# 064 — MCP Deferred Tool Loading (List/Mount Pattern)

**Date**: 2026-07-12

## Context

Real-world MCP servers can expose hundreds of tools, consuming most of the LLM's context window with tool definitions alone:

| Server | Tools | Token Cost |
|--------|-------|------------|
| Datadog MCP | 142 across 22 toolsets | ~70K+ tokens |
| MCP_DOCKER | 135 | ~126K tokens |
| Cloudflare native MCP | entire API | ~1.17M tokens |

Three MCP servers can eat 72% of a 200K context window before the user types anything. Tool selection accuracy drops from 95% with 4 tools to 71% with 46 tools. The previous approach — mounting every MCP tool eagerly as a native tool definition at connection time — was unbounded: context cost grew linearly with server tool count.

## Decision

Replace eager tool mounting with a **deferred list/mount pattern**. When an MCP server connects, its individual tools are NOT mounted as native LLM tool definitions. Instead, three meta-tools are mounted per server:

- **`<serverId>__list_tools`** — Returns tool names and descriptions (no schemas). The LLM calls this to browse available tools.
- **`<serverId>__mount_tool`** — Dynamically registers a specific tool with its full JSON schema as a native tool definition. The LLM calls this after discovering a tool it wants to use.
- **`<serverId>__unmount_tool`** — Removes a previously mounted tool from the active tool list.

This bounds context cost to 3 meta-tools per server regardless of how many tools the server offers.

### Key Design Choices

1. **All MCP servers use list/mount** — no threshold, no "monster vs normal" split. Any reasonable threshold would be crossed frequently enough that transition logic isn't worth the complexity.
2. **`__list_tools` returns names + descriptions only** (no schemas) — the LLM mounts somewhat blind, then gets the full schema via `__mount_tool`. This keeps the list response small even for monster servers.
3. **No auto-eviction** — overmounting is no worse than the previous status quo, only for the session. The LLM is not trusted to self-evict (it's not aware of its own context usage, and the more tools mounted, the less likely it remembers an unmount tool exists).
4. **`notifications/tools/list_changed` unmounts stale tools surgically** — the `handleToolsListChanged` function diffs the old and new tool caches, unmounts tools that no longer exist on the server, and updates the cache. This is surgical (per-server) rather than nuking all MCP plugin tools.
5. **Resources, prompts, and resource templates stay eagerly mounted** — they do not have the same context cost profile as tool definitions.
6. **Allowlist enforced by `__mount_tool`** — `__list_tools` shows all tools (so the LLM knows what exists), but mounting a non-allowlisted tool throws an error.

### Engine API Addition: `unregisterTool`

A new `unregisterTool(canonicalName: string)` method was added to both `DronePluginRegistration` and `DronePluginEngine`, complementing the existing `unregisterPluginTools(pluginId)` for bulk removal. This is needed for:
- `__unmount_tool` meta-tool to remove individual mounted tools
- `handleToolsListChanged` to surgically unmount stale tools

### `discoveredToolCount` Layering Fix

The redundant write of `discoveredToolCount` in `index.ts` (which overwrote the value already set by `client.ts`) was removed. Now `discoveredToolCount` is set only by the client, and `mountedToolCount` reflects only tools the LLM has chosen to mount via `__mount_tool`.

## Long-term Vision

If this pattern works well for MCP, it may be expanded globally to all tools (not just MCP) to bound context cost across the entire tool surface. This implementation is a stepping stone toward that vision.

## Research Context

Other MCP clients handle this problem differently:
- **Claude Code (Anthropic)**: Tool Search meta-tool with deferred loading (85% token reduction)
- **Cursor IDE**: Hard cap (40→80 tools, silently drops extras)
- **Datadog/Speakeasy**: Server-side tag/toolset filtering
- **MCP spec**: Has pagination and `list_changed` but no standard for tool filtering or progressive discovery (SEP-1300 rejected, SEP-1821 still open)

The list/mount pattern is a novel approach — "the road less travelled" — that gives the LLM native tool schemas (unlike list/call) while bounding context cost.

## Commits

- `bc2d7db` — Step 1: Add `unregisterTool` to the plugin engine
- `9d0bf6e` — Steps 2-10: Implement deferred list/mount tool loading for MCP
- `5c514cc` — Step 11: Document MCP deferred tool loading in AGENTS.md

## Related

- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — The MCP client module (updated for list/mount)
- [plugin-system](002-plugin-system.md) — Plugin tool registration, `unregisterTool`
- [DronePlugin](../../drone-core/src/plugin-system.ts) — `DronePluginRegistration` interface (added `unregisterTool`)
- [061-mcp-notifications-tools-list-changed](061-mcp-notifications-tools-list-changed.md) — Prior `list_changed` handling (now surgical)
- [054-mcp-http-sse-stream-delete](054-mcp-http-sse-stream-delete.md) — GET SSE stream (enables notifications)