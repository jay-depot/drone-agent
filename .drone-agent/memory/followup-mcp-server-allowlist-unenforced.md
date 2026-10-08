---
key: followup-mcp-server-allowlist-unenforced
tags: []
created: 2026-10-08T21:06:23.918Z
updated: 2026-10-08T21:06:23.918Z
---

# Follow-up: MCP per-server `allowedTools` is unenforced

**Discovered:** 2026-10-08, while implementing `plan-mcp-server-description-surfacing` (ADR 240)
**Status:** Not started
**Severity:** Medium — a documented config knob silently does nothing

## The defect

`mcp.servers.<id>.allowedTools` (a per-server tool allowlist in `.drone-agent/config.json`) is **not enforced**. There are no filters between the LLM and those tools.

Verified by grepping the whole workspace for `serverAllowlists`:

- `drone-agent/src/plugins/mcp/index.ts:178` — `const serverAllowlists = new Map<string, Set<string> | undefined>();`
- `drone-agent/src/plugins/mcp/index.ts:332` — `serverAllowlists.set(serverId, allowedToolSet);`

**Two hits, both writes.** No reader exists. The map is populated and never consulted.

## How it happened

ADR 065 documented that the per-server `__mount_tool` meta-tool enforced `allowedTools` (a non-allowlisted tool threw on mount). ADR 105 deleted the per-server meta-tools in favour of the engine-owned `runtime__list_tools` / `runtime__mount_tool`. That removal took the enforcement with it: the engine's mount path knows nothing about a plugin-specific allowlist, and nothing re-added a check.

The `serverAllowlists` map was left behind as a write-only remnant.

## Consequences

1. **The allowlist is decorative.** An operator can allowlist a server down to two tools; the LLM still sees and can mount all of them.
2. **`filteredToolCount` overstates filtering.** `connection.state.filteredToolCount` is computed as `tools.length - allowlistedCount`, so it reports N tools as "filtered" when they are all still reachable. Do **not** use it as an "available tool count" — ADR 240's header fragment deliberately computes the available count from the persona filter instead.
3. `mcp__server_status` reports the misleading `filteredToolCount`.

Contrast: the **per-persona** `allowedTools` (glob patterns) _is_ enforced, by the engine, at the `runtime__list_tools` seam (`plugin-engine.ts:879`) and in `getLlmTools()`.

## Options to revisit

- **Enforce at the `runtime__list_tools` / persona seam.** Mirrors the working per-persona mechanism: compose a per-server allowlist filter alongside `personaCap.getFilteredTools`. Keeps one enforcement point.
- **Enforce at mount.** Closest to ADR 065's original semantics (reject a non-allowlisted mount with an error), but splits enforcement across two seams and gives the LLM a discoverable-but-unmountable tool.
- **Delete the field.** If the per-persona allowlist is deemed sufficient, remove `allowedTools` from the MCP server config types + schema and delete `serverAllowlists` / `filteredToolCount`. Do not leave a knob that does nothing.

Recommendation: enforce at the list/mount seam (option 1), since the per-persona filter proves the mechanism and users expect the config knob to work.

## Related

- ADR 240 (`docs/adr/240-mcp-server-description-surfacing.md`) — surfaced this defect; explicitly declined to fix it in scope.
- ADR 105 (`docs/adr/105-runtime-level-list-mount.md`) — the change that removed enforcement.
- ADR 065 (`docs/adr/065-mcp-tool-mounting-cache-and-server-descriptions.md`) — the original (now false) claim that `__mount_tool` enforced it.
- `docs/agents/mcp-plugin.md` — documents this gap under "Known gap".
