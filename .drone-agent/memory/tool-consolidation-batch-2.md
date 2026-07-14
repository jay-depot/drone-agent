---
key: tool-consolidation-batch-2
tags:
  - tool-consolidation
  - batch-2
  - completed
created: 2026-07-14T06:32:23.191Z
updated: 2026-07-14T06:51:06.864Z
---

# Tool Consolidation Batch 2

Completed 2026-07-14. Reduced 28 tools to 14 across 7 plugins, plus MCP resource/prompt consolidation (5→2 per server) and subagent pokemon name fix.

## Changes

| Plugin | Before | After | Saved | Pattern |
|--------|--------|-------|-------|---------|
| Notepad | 3 | 1 | 2 | action param (`notepad__manage`) |
| Search | 2 | 1 | 1 | mode param (`search__text` absorbs `search__semantic`) |
| Skills | 4 | 3 | 1 | reload param (`skills__list` absorbs `skills__reload`) |
| Persona | 4 | 3 | 1 | showCurrent param (`persona__list` absorbs `persona__current`) |
| Config | 3 | 2 | 1 | showLayers param (`config__get` absorbs `config__list_layers`) |
| Memory | 5 | 2 | 3 | action params (`memory__manage` + `memory__browse`) |
| Self-improvement | 7 | 2 | 5 | action params (`self-improvement__insight` + `self-improvement__principle`) |
| MCP (per server) | 5 | 2 | 3 | action params (`__list` + `__get`) |
| Subagent | 1 (pokemon) | 1 (clean) | 0 | renamed `subagent__dispatch` → `dispatch` |
| **Total** | **~34** | **~17** | **~17** | |

## Files Modified

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
- All 1437 tests pass, typecheck and build clean