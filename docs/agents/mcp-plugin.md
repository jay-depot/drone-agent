# MCP Plugin (Deferred Tool Loading)

The MCP plugin uses a **deferred list/mount pattern** for tool loading, backed by a `ToolMountingCache` class in `drone-core`. When an MCP server connects, its individual tools are NOT mounted as native LLM tool definitions. Instead, three meta-tools are mounted per server:

- **`<serverId>__list_tools`** — Returns tool names and descriptions (no schemas). The LLM calls this to browse available tools.
- **`<serverId>__mount_tool`** — Dynamically registers a specific tool with its full JSON schema as a native tool definition. The LLM calls this after discovering a tool it wants to use via `__list_tools`.
- **`<serverId>__unmount_tool`** — Removes a previously mounted tool from the active tool list.

This bounds context cost to 3 meta-tools per server regardless of how many tools the server offers. Real-world MCP servers like Datadog (142 tools, ~70K tokens) or MCP_DOCKER (135 tools, ~126K tokens) can otherwise consume most of the context window with tool definitions alone.

## ToolMountingCache

`drone-core/src/tool-mounting-cache.ts` is a reusable data structure for managing list/mount style tool collections. One instance is created per MCP server, preventing cross-server tool clobbering. It stores full `DroneToolDefinition` objects and provides `addTool`, `removeTool`, `mountTool`, `unmountTool`, and query methods. The cache uses the plugin ID to construct canonical names for engine registration/unregistration.

## Eagerly Mounted Items

Resources, prompts, and resource templates are still mounted eagerly (they do not have the same context cost profile as tool definitions).

## Allowlisting

The `allowedTools` allowlist is enforced by `__mount_tool` — `__list_tools` shows all tools, but mounting a non-allowlisted tool throws an error.

## Server Descriptions

When connecting to a new MCP server, the plugin optionally calls the LLM (via the `llm` optional dependency) to generate a ≤3-sentence summary of what the server does. The summary is included in the `__list_tools` description, giving the LLM context for which tools to mount. Descriptions are cached at `~/.drone-agent/cache/mcp/server-descriptions.json` (user scope, keyed by server ID). If no LLM is available, the description falls back to a generic string.

## Persona Filtering

When the `persona` optional dependency is available, `__list_tools` filters its output through the active persona's `allowedTools` patterns. This ensures the LLM only sees tools it is permitted to mount, preventing confusion from tools that would be rejected by `__mount_tool`.

## Tool List Change Notifications

When the server sends `notifications/tools/list_changed`, the plugin surgically updates the per-server tool cache and unmounts any tools that no longer exist on the server (without nuking all MCP plugin tools across all servers).

The `unregisterTool(canonicalName)` method on the plugin engine is used for single-tool removal, complementing the existing `unregisterPluginTools(pluginId)` for bulk removal.

## Long-term Vision

If this pattern works well for MCP, it may be expanded globally to all tools (not just MCP) to bound context cost across the entire tool surface.
