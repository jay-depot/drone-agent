---
key: status-bar-tools-yx-plus-slash-tools-filter
tags:
  - plan
  - tui
  - status-bar
  - slash-commands
  - tool-filtering
  - implemented
created: 2026-07-01T22:52:09.679Z
updated: 2026-07-01T23:12:06.548Z
---

# IMPLEMENTED: `tools:Y/X` Status Bar + `/tools` Filtered Listing

## Summary

Implemented two UI changes to make tool visibility more transparent:

1. **Status bar** shows `tools:available/total` instead of `tools:total`
2. **`/tools` slash command** shows the filtered (available) tool list, and `/tools --all` shows the full unfiltered list

## Files Changed

### `drone-agent/src/tui/app.tsx`
- Added `import type { DroneToolDescriptor } from 'drone-core'`
- Replaced single `toolCount` with `totalTools` + `availableTools`
- `availableTools` is computed via persona's `getFilteredTools()` when available, otherwise filters out `defaultHidden` tools
- Status bar renders `tools:availableTools/totalTools`
- **Note:** Uses optional chaining `personaCapForTools?.getFilteredTools` instead of just truthy-checking the cap, because some mock persona caps (e.g. in `tui-persona-color.test.tsx`) may exist but not include `getFilteredTools`

### `drone-agent/src/runtime/builtin-commands.ts`
- Added `import type { DroneToolDescriptor } from 'drone-core'`
- Updated `/tools` handler to default to filtered view (via persona capability), with `--all` flag for unfiltered
- Header changes: `Available tools (Y/X):` vs `All registered tools (X):`
- Description updated to mention `--all`

### `drone-agent/test/tui.test.tsx`
- `makeOptions()` now returns 3 tools via `listTools()` matching `getRegisteredToolCount: () => 3`
- Assertion updated from `'tools:3'` to `'tools:3/3'`
- Same in mid-panel test's `makeOptions()` override

### `drone-agent/test/builtin-commands.test.ts` (NEW)
- 4 tests: `/tools --all` shows all, `/tools` filters via persona, `/tools` hides `defaultHidden` when no persona, `/tools --all` shows hidden tools

## Commits
- Plan: `244fff1` (plan: tools:Y/X status bar + /tools --all filtering)
- Implementation: `e3ad584` (feat: tools:Y/X status bar + /tools filtered + --all flag)

## Validation
- `pnpm typecheck`: Only pre-existing errors in `llm-provider-switching.test.ts`
- `pnpm test`: 827 passed, 48 files, 0 failures
- `pnpm lint`: Only pre-existing errors in `drone-swarm-common/src/tls.ts`