# MCP Plugin (Deferred Tool Loading)

The MCP plugin connects to configured MCP servers and exposes their tools, resources, and prompts to the LLM. Tool loading is **deferred**: an MCP server's tools are registered with the engine **unmounted**, and the runtime-level meta-tools handle discovery and mounting.

## Deferred List/Mount via the Runtime Meta-Tools

Every tool in the engine starts unmounted. Three engine-owned meta-tools are always available:

- **`runtime__list_tools`** — Lists unmounted tools, optionally filtered by plugin (`{"plugin": "mcp"}`) and optionally with input schemas (`includeSchemas: true`). The output is filtered by persona visibility.
- **`runtime__mount_tool`** — Mounts a tool by canonical name (e.g. `"mcp__demo__echo"`). A mounted tool appears in the LLM's tool list with its full schema.
- **`runtime__unmount_tool`** — Unmounts a previously mounted tool.

This bounds context cost to three meta-tools total (not per server), regardless of how many tools the configured servers offer. Real-world MCP servers like Datadog (142 tools, ~70K tokens) or MCP_DOCKER (135 tools, ~126K tokens) can otherwise consume most of the context window with tool definitions alone.

The engine owns this mechanism (`ToolRegistry` in drone-core). The MCP plugin registers its tools directly with `registration.registerTool()` and holds no cache of its own.

## Server Tool Registration

When an MCP server connects, `reconcileServerTools` (in `index.ts`) lists the server's tools and registers each one as an **unmounted** tool named `<serverId>__<tool>`, which the engine prefixes to `mcp__<serverId>__<tool>`. The per-server tool map is kept in `serverToolMaps` for reconnects and fragment rendering.

`reconcileServerTools` is **idempotent and surgical**: it diffs the previously registered set (from `serverToolMaps`) against the freshly listed set and unregisters only tools that vanished, registers only tools that appeared, and leaves persisting tools completely untouched (so their engine mount state is preserved). A no-op reconcile — the common case — changes nothing. This is what makes a repeated connect / list-change / reconnect safe: re-registering an already-registered canonical name would throw `Tool already registered` from the engine.

All reconcile call sites (initial mount, stdio respawn, `tools/list_changed`) are serialized per server through `withKeyLock('mcp:<serverId>', …)` (`shared/keyed-lock.ts`). The lock is a **serializing chain, not a coalescer**: a `notifications/tools/list_changed` arriving mid-reconcile re-lists _afterwards_ (the list did change), rather than being dropped.

## Per-Server Helper Tools

Each connected server also gets two regular unmounted tools for its resources and prompts:

- **`mcp__<serverId>__list`** — Lists resources, resource templates, or prompts (`type: "resources" | "resource_templates" | "prompts"`).
- **`mcp__<serverId>__get`** — Reads a resource by `uri`, or fetches a prompt by `name` (with optional `arguments`).

These helpers are registered **once per server** (tracked in `registeredResourceServers`), so no reconnect or list-change can re-register them and collide.

`mcp__server_status` is registered once at plugin registration time and reports each server's connection state and mounted-tool counts.

Resources and prompts are **not** mounted eagerly — they follow the same deferred pattern as tools.

## Tool List Change Notifications

When the server sends `notifications/tools/list_changed`, `handleToolsListChanged` runs a keyed `reconcileServerTools` for that server only; other servers are untouched. Because the reconcile is surgical, tools that still exist keep their engine mount state.

`registration.unregisterTool(canonicalName)` removes a single tool; `registration.unregisterPluginTools(pluginId)` remains available for bulk removal.

## Reconnect vs. Stream-Open

The client distinguishes two transport events, and the plugin reacts to them differently:

- **`onStreamOpened`** — the GET SSE (server→client notification) stream opened or reopened. The plugin only flips `state.streaming = true` and clears `state.lastStreamError`. It **never** remounts. A streamable-HTTP connect fires this as soon as the GET stream opens — which is the _first_ connect, not a reconnect.
- **`onReconnected`** — a genuine transport reconnect that may have changed the tool surface. It fires **only** on a stdio child respawn, and the plugin reconciles the server's tools there.

An initial connect fires **neither** remount path; the initial mount is the caller's explicit keyed `reconcileServerTools(…, 'ready')` after `createMcpClientConnection` resolves. Both fire-and-forget call sites carry a `.catch`, so a future failure degrades to a log line instead of aborting the process via an unhandled rejection. See ADR 252.

## Server Descriptions

When connecting to a new MCP server, the plugin calls an LLM — via the `llm` optional dependency and the `describer` model role — with the server's tool list. The model writes a one-sentence summary of what the server does. This gives the LLM context for deciding which server's tools to mount.

- **Blocking at connection time** — the description is generated before the server's tools are registered, so a server's first tool listing always has context available. One-time cost per server.
- **Fail-open** — if no LLM is available, or the call fails, no description is produced and the server is still listed (without prose). A failure logs a warning and never throws.

### Caching and Invalidation

Descriptions are cached at `~/.drone-agent/cache/mcp/server-descriptions.json` (user scope, one JSON file keyed by server ID):

```json
{
  "searxng": {
    "description": "A privacy-focused metasearch engine that aggregates results from multiple search sources.",
    "generatedAt": "2026-07-13T19:48:42.000Z",
    "promptVersion": 2
  }
}
```

- **`promptVersion` cache-bust** — each entry records the summarizer-prompt version that produced it. An entry whose `promptVersion` does not match the current version is treated as a cache miss and regenerated on the server's next connect. This is how a prompt change re-summarizes existing servers without a manual cache delete.
- **Writes are serialized and atomic** — the read-modify-write cycle is guarded by a per-path lock and written via a temp file plus rename, so concurrent connects cannot lose an update.
- Tool-list-hash comparison and TTL-based invalidation are **not** implemented (deferred).

## Prompt Fragments

The plugin registers two fragments that tell the LLM which MCP servers exist and how to reach their tools.

### `# MCP Servers` (header)

Lists every configured server with its **available** tool count and, when known, its description. It also carries the reminder blurb telling the model how to browse and mount tools:

```
# MCP Servers

MCP tools must be mounted before use. Call `runtime__list_tools` with
`{"plugin":"mcp"}` to see a server's tools. If a tool you expect from a
server below is missing, list it again — the list may be stale, or the
tool may be named differently.

- searxng (2 tools): A privacy-focused metasearch engine that aggregates results from multiple search sources.
- github (26 tools): Full-featured GitHub automation for issues, pull requests, branches, and code search.
```

The available count is computed **at render time** by passing the server's tool descriptors through the persona capability's `getFilteredTools`, so it reflects exactly what the LLM can mount. With no persona capability, the count falls back to all tools minus any `defaultHidden` ones. Servers with no known description are still listed (id and count, no prose).

The fragment lives in the **header** so its content stays in the cached prompt prefix.

### `# MCP Servers (not connected)` (footer)

Lists **only** servers whose status is not `connected` (i.e. `connecting`, `disconnected`, or `error`), with the status and any `lastError` detail. It renders `false` — contributing nothing — when every server is connected.

Status is volatile, so it rides the **footer** (re-rendered per turn) rather than the header. This keeps connection churn from invalidating the cached prefix while still surfacing the case the reminder above is most useful for: a server whose tools are expected but unavailable.

```
# MCP Servers (not connected)

- github: error — spawn npx ENOENT
```

## Persona Filtering

The persona's `allowedTools` patterns are applied by the engine at the `runtime__list_tools` seam and in the conversation service's tool list, so the LLM only sees tools it is permitted to mount. There is no per-server filtering inside the MCP plugin.

**Known gap:** the per-server `allowedTools` field in `mcp.servers.<id>` is currently **not enforced** — it is read into a set that is never consulted, so an allowlisted-out tool remains visible and mountable. Enforcement was lost when the per-server meta-tools were removed. Tracked as a follow-up.

## Dependencies

`llm` and `persona` are both **optional** dependencies. Without `llm`, no descriptions are generated (cached ones are still shown). Without `persona`, no tool filtering is applied and the available count is the unfiltered total.
