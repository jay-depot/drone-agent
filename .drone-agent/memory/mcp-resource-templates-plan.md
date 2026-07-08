---
key: mcp-resource-templates-plan
tags:
  - mcp
  - plan
  - resource-templates
  - gap-item-5
  - completed
created: 2026-07-08T15:52:46.025Z
updated: 2026-07-08T16:06:08.859Z
---

# Plan: MCP Resource Template Support (gap item 5) — COMPLETED 2026-07-08

Source gap entry: `mcp-client-gaps` (item 5 — "No resource templates (`resources/templates/list`/`read`); `DroneMcpResourceMeta` only models concrete resources.").

## Summary / why

The MCP client could only discover and read *enumerated* (concrete) resources. Servers that
front large or dynamic namespaces (filesystems, databases, git, API gateways) advertise a
**URI template** (RFC 6570) via `resources/templates/list` instead of (or in addition to) a
finite resource list. Today those servers appeared to expose zero readable resources — the
client was blind to them. This plan added template discovery and surfaced it to the LLM as a
per-server tool, closing an "Important (capability)" gap and improving spec compliance.

Key spec fact: there is **no** `resources/templates/read` method. A template is read by
substituting its variables into a concrete URI and calling the shared `resources/read`. The
read path was reused; only the existing `__read_resource` tool's description was updated.

## Decisions (confirmed with user)

- Surface method: dedicated per-server tool `__list_resource_templates`, mirroring the
  existing `list_resources`/`read_resource` and `list_prompts`/`get_prompt` split.
- Read path: REUSED. `__read_resource` remains the single read tool for both concrete and
  filled-in template URIs.

## Implementation (all done)

### Step 1 — `DroneMcpResourceTemplateMeta` (drone-core)
File: `drone-core/src/mcp-types.ts`. Added `DroneMcpResourceTemplateMeta`
`{ uriTemplate, name?, description?, mimeType?, arguments?: DroneMcpPromptArgument[] }`.
Reused the existing `DroneMcpPromptArgument` type for template arguments (no new arg type
needed). Exported from `drone-core/src/index.ts`.

### Step 2 — state truncation field (drone-core)
Added `resourceTemplatesListTruncated?: boolean` to `DroneMcpServerState`.

### Step 3 — client normalize + list (drone-agent)
File: `drone-agent/src/plugins/mcp/client.ts`.
- Added `normalizeResourceTemplateArguments()` + `normalizeResourceTemplates()` (mirrors
  `normalizeResources`, reads `uriTemplate`, maps optional fields + arguments).
- Added `listResourceTemplates()` to `McpClientConnection`, calling `paginateList`
  (`'resources/templates/list'`) and setting `state.resourceTemplatesListTruncated`.

### Step 4 — plugin mount tool (drone-agent)
File: `drone-agent/src/plugins/mcp/index.ts`. In `mountResourcePromptTools`, added a
`${serverId}__list_resource_templates` tool (JSON output `{ serverId, templates }`) and
updated the `__read_resource` description to note it accepts filled-in template URIs.

### Step 5 — fake server (test doubles)
- `drone-agent/test/mcp-fake-server.ts`: added `DEFAULT_RESOURCE_TEMPLATES`, a
  `resourceTemplates` option, and a `resources/templates/list` handler (with cursor pagination).
- `drone-agent/test/mcp-fake-server.mjs`: added `RESOURCE_TEMPLATES` + the stdio handler, so
  the slow integration suite's spawned child also serves templates (otherwise `onPluginsLoaded`
  would error and the mount test would fail).

### Step 6 — tests
- `drone-agent/test/mcp-client.test.ts`: added 4 cases in the normalization block — list via
  `resources/templates/list`, `uriTemplate` normalization, arguments passthrough, and
  `resourceTemplatesListTruncated` on pagination overflow.
- `drone-agent/test/mcp.test.ts`: added `mcp__demo__list_resource_templates` to the mount
  assertion, plus a behavioral test that lists templates then reads a filled-in template URI
  (`file:///etc/hostname`) through `__read_resource`.

### Bonus fix (required for the build gate to be green)
The global `pnpm build` was RED at baseline (pre-existing, unrelated to this plan) due to
`drone-core/src/index.ts` not exporting `DroneElicitation`, causing TS2305/TS7006 errors in
6 files (`elicitation.ts`, `external-loader.ts`, `persona/wizard.ts`, `skills/wizard.ts`,
`runtime/plugin-engine.ts`, `tui/elicitation.ts`). These appeared in the session's initial
LSP diagnostics before any change. Added `DroneElicitation` to the index.ts re-export list;
this single line clears all those errors and unblocks the build/typecheck/lint gate.

## Validation (all green)

- `pnpm build` — all packages Done.
- `pnpm typecheck` — all packages Done.
- `pnpm lint` — clean.
- `pnpm test` — 87 test files / 1274 tests passed (incl. 6 new template tests). Slow
  integration suite (`mcp.test.ts`) passes; `e2e-swarm`/`coordinator-sync` etc. are excluded
  by repo config (unchanged behavior).

## Behavioral outcome

A server exposing only `resources/templates/list` (no concrete `resources/list`) now yields a
usable `__list_resource_templates` tool, and a URI formed by substituting its variables is
readable via the existing `__read_resource` tool. Gap item 5 is CLOSED.

## Out of scope

- `resources/templates/read` (not a real MCP method).
- Auto-reconnect / pagination edge cases beyond existing `paginateList` behavior.
- Swarm/wiki tool parity (templates are a client-side MCP concern only).
