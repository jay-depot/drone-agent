---
tags: [decision, tool-consolidation]
related: [modules/drone-agent-plugins.md, decisions/068-tool-reduction-followup.md, decisions/030-default-hidden-tool-gating.md]
---

# 071: Tool Consolidation Batch 2

**Status**: Implemented (2026-07-14)

## Context

After the first tool reduction ([[decisions/068-tool-reduction-followup]]) which converted git and swarm to list/mount pattern and consolidated utils, there were still 28 tools across 7 plugins that could be consolidated using action-based parameter patterns. Additionally, the MCP plugin's per-server resource/prompt tools (5 per server) could be consolidated to 2, and the subagent plugin had a pokemon naming bug (`subagent__subagent__dispatch`).

## Decision

Consolidate 28 tools into 14 across 7 plugins using action-based parameter patterns, plus MCP resource/prompt tools (5→2 per server) and a subagent pokemon name fix.

### Changes

| Plugin | Before | After | Saved | Pattern |
|--------|--------|-------|-------|---------|
| Notepad | 3 | 1 | 2 | `notepad__manage` with `action: "set" \| "clear" \| "append"` |
| Search | 2 | 1 | 1 | `search__text` with `mode: "regex" \| "semantic"` |
| Skills | 4 | 3 | 1 | `skills__list` with `reload: boolean` |
| Persona | 4 | 3 | 1 | `persona__list` with `showCurrent: boolean` |
| Config | 3 | 2 | 1 | `config__get` with `showLayers: boolean` |
| Memory | 5 | 2 | 3 | `memory__manage` + `memory__browse` with action params |
| Self-improvement | 7 | 2 | 5 | `self-improvement__insight` + `self-improvement__principle` with action params |
| MCP (per server) | 5 | 2 | 3 | `__list` + `__get` with type params |
| Subagent | 1 (pokemon) | 1 (clean) | 0 | `subagent__subagent__dispatch` → `subagent__dispatch` |
| **Total** | **~34** | **~17** | **~17** | |

### Key design decisions

- **Action-based params** for small tool groups (3-7 tools) where operations share common parameters
- **List/mount pattern** (already used for git, swarm, MCP tools) remains the choice for larger groups
- The `required` field in JSON schema only includes `action` — other fields are conditionally required based on the action value (a JSON Schema limitation, but works well in practice)

## Consequences

- Native tool surface reduced by ~17 tools
- The `self-improvement__insight` tool now handles record/list/recall via action param (replacing 3 separate tools)
- The `self-improvement__principle` tool now handles store/list/recall/delete via action param (replacing 4 separate tools)
- The `memory__manage` tool now handles store/recall/delete via action param (replacing 3 separate tools)
- The `memory__browse` tool now handles list/search via action param (replacing 2 separate tools)
- The `notepad__manage` tool now handles set/clear/append via action param (replacing 3 separate tools)
- The `search__text` tool now has a `mode` param (`regex`/`semantic`) absorbing `search__semantic`
- The `skills__list` tool now has a `reload` param absorbing `skills__reload`
- The `persona__list` tool now has a `showCurrent` param absorbing `persona__current`
- The `config__get` tool now has a `showLayers` param absorbing `config__list_layers`
- MCP per-server tools consolidated from 5 (`__list_tools`, `__mount_tool`, `__unmount_tool`, `__list`, `__get`) — wait, `__list_tools`/`__mount_tool`/`__unmount_tool` are the deferred loading meta-tools and were NOT consolidated. The consolidation was of the resource/prompt tools: `__list_resources`, `__read_resource`, `__list_prompts`, `__get_prompt`, `__list_resource_templates` → `__list` (with `type: "resources" | "prompts" | "resource_templates"`) and `__get` (with `type: "resource" | "prompt"`).
- Subagent pokemon name fixed: `subagent__subagent__dispatch` → `subagent__dispatch`
- The `default-hidden-tools.md` concept page and `decisions/030` need updating to reflect the new consolidated tool names

## Files Changed

- `drone-agent/src/plugins/notepad.ts` — replaced 3 tools with 1
- `drone-agent/src/plugins/search.ts` — removed `search__semantic`, added `mode` param
- `drone-agent/src/plugins/skills/index.ts` — removed `skills__reload`, added `reload` param to `skills__list`
- `drone-agent/src/plugins/persona/index.ts` — removed `persona__current`, added `showCurrent` param to `persona__list`
- `drone-agent/src/plugins/config/index.ts` — removed `config__list_layers`, added `showLayers` param to `config__get`
- `drone-agent/src/plugins/memory/index.ts` — replaced 5 tools with 2
- `drone-agent/src/plugins/self-improvement/index.ts` — replaced 7 tools with 2
- `drone-agent/src/plugins/self-improvement/tools/insight.ts` — combined record/list/recall
- `drone-agent/src/plugins/self-improvement/tools/principle.ts` — new file, combined store/list/recall/delete
- Deleted 6 old self-improvement tool files
- `drone-agent/src/plugins/mcp/index.ts` — replaced 5 resource/prompt tools with 2 per server
- `drone-agent/src/plugins/subagent/plugin.ts` — fixed pokemon naming
- Updated 10 test files
