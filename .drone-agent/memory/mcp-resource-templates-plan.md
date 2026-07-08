---
key: mcp-resource-templates-plan
tags:
  - mcp
  - plan
  - resource-templates
  - gap-item-5
created: 2026-07-08T15:52:46.025Z
updated: 2026-07-08T15:52:46.025Z
---

# Plan: MCP Resource Template Support (gap item 5)

Source gap entry: `mcp-client-gaps` (item 5 — "No resource templates (`resources/templates/list`/`read`); `DroneMcpResourceMeta` only models concrete resources.").

## Summary / why

The MCP client can only discover and read *enumerated* (concrete) resources. Servers that
front large or dynamic namespaces (filesystems, databases, git, API gateways) advertise a
**URI template** (RFC 6570) via `resources/templates/list` instead of (or in addition to) a
finite resource list, so a model can reason about *classes* of readable data it cannot
enumerate. Today those servers appear to expose zero readable resources — the client is
blind to them. This plan adds template discovery and surfaces it to the LLM as a per-server
tool, closing an "Important (capability)" gap and improving spec compliance.

Key spec fact driving the design: there is **no** `resources/templates/read` method. A
template is read by substituting its variables into a concrete URI and calling the shared
`resources/read`. Therefore the *read* path needs no new code — only the existing
`__read_resource` tool's description is updated so the model knows it accepts filled-in
template URIs.

## Decisions (confirmed with user)

- Surface method: dedicated per-server tool `__list_resource_templates`, mirroring the
  existing `list_resources`/`read_resource` and `list_prompts`/`get_prompt` split.
- Read path: REUSED. `__read_resource` remains the single read tool for both concrete and
  filled-in template URIs.
- No separate `resourceTemplatesRead` — that is not a real MCP method.

## Files & changes (in dependency order)

### Step 1 — Type: add `DroneMcpResourceTemplateMeta` (drone-core)
File: `drone-core/src/mcp-types.ts`
Add after `DroneMcpResourceMeta`:
```ts
export type DroneMcpResourceTemplateArgument = {
  name: string;
  required?: boolean;
  description?: string;
};

export type DroneMcpResourceTemplateMeta = {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
  arguments?: DroneMcpResourceTemplateArgument[];
};
```
Then `pnpm build` (drone-core must recompile before client imports the new type).

Agent type: coder. Depends on: nothing. Validates by: `pnpm build` succeeds.

### Step 2 — State: track template truncation (drone-core)
File: `drone-core/src/mcp-types.ts`, `DroneMcpServerState`
Add field (parity with `resourcesListTruncated`):
```ts
resourceTemplatesListTruncated?: boolean;
```

Agent type: coder. Depends on: Step 1. Validates by: typecheck.

### Step 3 — Client: normalize + list templates (drone-agent)
File: `drone-agent/src/plugins/mcp/client.ts`
- Add a `normalizeResourceTemplates(result: unknown): DroneMcpResourceTemplateMeta[]`
  function, mirroring `normalizeResources` but reading `uriTemplate` (string-required) instead
  of `uri`, and mapping optional `name`/`description`/`mimeType`/`arguments` (the latter via a
  small inline normalizer for `{name,required?,description?}`).
- In the returned `McpClientConnection`, add:
  ```ts
  listResourceTemplates: async () => {
    const result = await paginateList(
      'resources/templates/list',
      normalizeResourceTemplates
    );
    state.resourceTemplatesListTruncated = result.truncated;
    return result.items;
  },
  ```
- Add `listResourceTemplates` to the `McpClientConnection` type declaration (top of file).

Agent type: coder. Depends on: Steps 1–2. Validates by: typecheck.

### Step 4 — Plugin: mount the `__list_resource_templates` tool (drone-agent)
File: `drone-agent/src/plugins/mcp/index.ts`
In `mountResourcePromptTools(serverId, connection)`, after the `__read_resource` tool, add:
```ts
registerMountedTool(
  `${serverId}__list_resource_templates`,
  `List MCP resource templates for server ${serverId}. Each template has a uriTemplate (RFC 6570) with variables to substitute, then read with ${serverId}__read_resource.`,
  { type: 'object', additionalProperties: false },
  async () => {
    const templates = await connection.listResourceTemplates();
    return JSON.stringify({ serverId, templates }, null, 2);
  }
);
```
Also update the `__read_resource` description to note it accepts both concrete URIs and
filled-in template URIs (e.g. append: " Also accepts a URI produced by substituting variables
into a resource template from `<serverId>__list_resource_templates`.").

Agent type: coder. Depends on: Step 3. Validates by: typecheck.

### Step 5 — Fake server: serve templates (drone-agent)
File: `drone-agent/test/mcp-fake-server.ts`
- Add `const DEFAULT_RESOURCE_TEMPLATES = [{ uriTemplate: 'file:///{path}', name: 'file', description: 'A file by path', arguments: [{ name: 'path', required: true }] }];`
- Add `resourceTemplates?: Array<{ uriTemplate: string; name?: string; description?: string; arguments?: ... }>` to `MockFetchOptions`.
- In `createMockFetch`, default `const resourceTemplates = options.resourceTemplates ?? DEFAULT_RESOURCE_TEMPLATES;` and add a handler:
  ```ts
  'resources/templates/list': (params) => {
    const cursor = ...; // reuse the same cursor pagination pattern as resources/list
    const start = cursor ? Number(cursor) : 0;
    const slice = resourceTemplates.slice(start, start + pageSize);
    const next = start + pageSize;
    return { resourceTemplates: slice, nextCursor: next < resourceTemplates.length ? String(next) : undefined };
  },
  ```
- Keep the header comment's method list in sync (add `resources/templates/list`).

Agent type: coder. Depends on: nothing (independent, but do before tests). Validates by: tsc/typecheck.

### Step 6 — Tests: template discovery + tool mount (drone-agent)
File: `drone-agent/test/mcp-client.test.ts`
Extend the `describe('resources and prompts normalization', ...)` block:
- `'normalizes resource templates with uriTemplate/name/description'` — `const t = await conn.listResourceTemplates();` assert `t.length > 0`, each has a `uriTemplate` string, and `t.map(x=>x.uriTemplate)` contains `'file:///{path}'`.
- `'lists resource templates via resources/templates/list'` — assert `mock.callCount('resources/templates/list') === 1`.
- Add an `arguments` normalization assertion (optional): a template with `arguments` carries them through.
Add a mount assertion (separate describe, or in the existing mount block) that a connection
exposes a registered tool named `<serverId>__list_resource_templates`. Reuse the existing
harness pattern (fast `createMockFetch` + `createMcpClientConnection`).

Agent type: tester. Depends on: Steps 3–5. Validates by: `pnpm test` (mcp-client.test.ts green).

## Validation criteria (all must pass)

1. `pnpm build` — drone-core + drone-agent compile.
2. `pnpm typecheck` — no LSP/type errors (all LSP diagnostics clean).
3. `pnpm lint` — ESLint + Prettier pass (project linting process).
4. `pnpm test` — full vitest suite green, including the new resource-template cases in
   `mcp-client.test.ts`.
5. Manual/behavioral: a server exposing only `resources/templates/list` (no concrete
   `resources/list`) now yields a usable `__list_resource_templates` tool, and a URI formed by
   substituting its variables is readable via the existing `__read_resource` tool.

## Out of scope

- `resources/templates/read` (not a real MCP method).
- Auto-reconnect / pagination edge cases beyond existing `paginateList` behavior.
- Swarm/wiki tool parity (templates are a client-side MCP concern only).
