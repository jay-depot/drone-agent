---
tags: [decision, mcp]
related: [modules/drone-agent-mcp-client.md, decisions/050-mcp-client-session-id-iserror.md, decisions/054-mcp-http-sse-stream-delete.md]
---

# ADR 056: MCP Resource Template Support (gap item 5)

**Summary**: The MCP client could only discover and read *enumerated* (concrete) resources. Servers that front large or dynamic namespaces (filesystems, databases, git, API gateways) advertise a **URI template** (RFC 6570) via `resources/templates/list` instead of (or in addition to) a finite resource list. This ADR adds template discovery and surfaces it to the LLM as a per-server tool, closing an "Important (capability)" gap and improving spec compliance.

## Context

The MCP gap analysis (`mcp-client-gaps`, item 5) identified that `DroneMcpResourceMeta` only models concrete resources (`{ uri, name?, description?, mimeType? }`). The client had no concept of a resource template — a parameterized URI pattern like `file:///{path}` or `db://users/{userId}`. Without templates, the agent has no way to know these things are *readable at all*: the current `read_resource` tool would only work if the LLM already magically knew a valid URI, which it can't because `list_resources` never surfaced the pattern.

## Decision

We add resource template support with the following design:

### Surface method: dedicated per-server tool

A dedicated `${serverId}__list_resource_templates` tool is mounted per server, mirroring the existing `list_resources`/`read_resource` and `list_prompts`/`get_prompt` split. This keeps concrete-resource and template concerns separate and is consistent with the existing tool naming convention.

### Read path: reused, not duplicated

There is **no** `resources/templates/read` method in the MCP spec. A template is read by substituting its variables into a concrete URI and calling the shared `resources/read`. Therefore the read path requires no new code — only the existing `__read_resource` tool's description is updated so the model knows it accepts filled-in template URIs.

### Type: `DroneMcpResourceTemplateMeta`

A new type in `drone-core/src/mcp-types.ts`:

```ts
export type DroneMcpResourceTemplateMeta = {
  uriTemplate: string;       // RFC 6570 URI template
  name?: string;
  description?: string;
  mimeType?: string;
  arguments?: DroneMcpPromptArgument[];  // Reuses existing argument type
};
```

The `arguments` field reuses the existing `DroneMcpPromptArgument` type (`{ name, required?, description? }`) — no new argument type was needed.

### State tracking

`DroneMcpServerState` gained `resourceTemplatesListTruncated?: boolean` for parity with `resourcesListTruncated` and `promptsListTruncated`.

### Client implementation

`client.ts` adds:
- `normalizeResourceTemplateArguments(value)` — normalizes the `arguments` array from the server response
- `normalizeResourceTemplates(result)` — reads `result.resourceTemplates`, maps each to `DroneMcpResourceTemplateMeta`
- `listResourceTemplates()` on `McpClientConnection` — calls `resources/templates/list` via the existing `paginateList` helper, sets `state.resourceTemplatesListTruncated`

### Plugin mounting

`index.ts` `mountResourcePromptTools()` adds the `${serverId}__list_resource_templates` tool (JSON output `{ serverId, templates }`). The `${serverId}__read_resource` tool description is updated to note it accepts both concrete URIs and URIs produced by substituting variables into a resource template.

### Test doubles

Both test harnesses serve `resources/templates/list`:
- **HTTP mock** (`mcp-fake-server.ts`): `DEFAULT_RESOURCE_TEMPLATES` with two entries (`file:///{path}`, `db://users/{userId}`), cursor-paginated handler, injectable via `options.resourceTemplates`
- **Stdio child** (`mcp-fake-server.mjs`): `RESOURCE_TEMPLATES` with one entry (`file:///{path}`), simple handler

### Tests

- **Fast suite** (`mcp-client.test.ts`): 4 new cases — list via `resources/templates/list`, `uriTemplate` normalization, arguments passthrough, `resourceTemplatesListTruncated` on pagination overflow
- **Integration suite** (`mcp.test.ts`): mount assertion for `mcp__demo__list_resource_templates`, plus a behavioral test that lists templates then reads a filled-in template URI (`file:///etc/hostname`) through `__read_resource`

## Consequences

### Positive

- **Spec compliance**: the client now supports `resources/templates/list`, a required capability for any MCP server that fronts a large or dynamic namespace.
- **Discovery**: the LLM can see parameterizable resource patterns and reason about them, instead of being blind to entire classes of data.
- **Smaller payloads**: one template replaces potentially millions of enumerated concrete resources, keeping `list` responses tiny.
- **Reuse**: the read path required zero new code — `resources/read` already accepts any URI, including filled-in template URIs.

### Negative

- **One more tool per server**: every MCP server now mounts one additional tool (`__list_resource_templates`), slightly increasing the tool namespace.

### Neutral

- The `arguments` field reuses `DroneMcpPromptArgument` rather than defining a new type — the shapes are identical (`{ name, required?, description? }`), so deduplication is appropriate.

## Related

- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — The MCP client module page (updated with resource template section)
- [050-mcp-client-session-id-iserror](050-mcp-client-session-id-iserror.md) — Previous MCP client fix (session-id + isError)
- [054-mcp-http-sse-stream-delete](054-mcp-http-sse-stream-delete.md) — Previous MCP client fix (GET SSE stream + DELETE)
- [051-mcp-client-test-suite](051-mcp-client-test-suite.md) — MCP test suite design
