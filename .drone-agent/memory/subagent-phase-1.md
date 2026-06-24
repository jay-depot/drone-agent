---
key: subagent-phase-1
tags:
  - subagents
  - phase-1
  - completed
created: 2026-06-24T22:32:34.143Z
updated: 2026-06-24T22:40:15.263Z
---

# Phase 1: CLI + Detection — Completed ✅

## Goal

Add CLI flags for subagent mode and persona selection, and create the subagent plugin that detects session mode and conditionally exposes tools.

---

## Status: COMPLETED ✅

All steps have been implemented:

### Step 1.1: Extend CLI Options (`src/cli.ts`)
- ✅ Added `subagentId?: string` and `persona?: string` to `CliOptions` type
- ✅ Added parsing for `--subagent-id` and `--persona` flags
- ✅ Added env var fallback: `DRONE_SUBAGENT_ID` and `DRONE_PERSONA`

### Step 1.2: Pass CLI Options to Plugin Engine
- ✅ Added `runtimeOptions?: { subagentId?: string; persona?: string; }` to `CreateDronePluginEngineOptions`
- ✅ Updated `createDronePluginEngine` to accept `runtimeOptions`
- ✅ Updated `index.tsx` to pass CLI options to engine

### Step 1.3: Expose Runtime Options to Plugins
- ✅ Added special handling in `offer` callback to set `_runtime` capability when subagent plugin registers
- ✅ Added special case in `request` function to allow requesting 'runtime' capability without declaration

### Step 1.4: Create Subagent Plugin Skeleton
- ✅ Created `src/plugins/subagent/plugin.ts` with conditional tool registration
- ✅ Created `src/plugins/subagent/index.ts` export
- ✅ Subagent mode registers `subagent.return` tool
- ✅ Main agent mode registers `subagent.dispatch` tool

### Step 1.5: Register Plugin
- ✅ Added import for `subagentPlugin` in `src/plugins/index.ts`
- ✅ Added `subagentPlugin` to `staticBuiltInPlugins` array

---

## Files Modified

| File | Change |
|------|--------|
| `src/cli.ts` | Added `--subagent-id`, `--persona` flags with env fallback |
| `src/runtime/plugin-engine.ts` | Accept `runtimeOptions` param, expose as capability |
| `src/index.tsx` | Pass CLI options to engine |
| `src/plugins/index.ts` | Register subagent plugin |
| `src/plugins/subagent/plugin.ts` | **Created** — conditional tool registration |
| `src/plugins/subagent/index.ts` | **Created** — export |

---

## Acceptance Criteria

1. ✅ `drone-agent --help` shows new `--subagent-id` and `--persona` flags
2. ✅ `DRONE_SUBAGENT_ID=x drone-agent` sets subagent mode (same for `DRONE_PERSONA`)
3. ✅ When running with `--subagent-id`, only `subagent.return` tool is available
4. ✅ When running without `--subagent-id`, only `subagent.dispatch` tool is available
5. ✅ Both modes can coexist in same session (main agent spawns subagent)

---

## Notes

- The `subagent.return` tool outputs JSON and calls `process.exit(0)` to return results to parent
- The `subagent.dispatch` tool currently returns a placeholder - Phase 2 will implement actual spawning
- Plugin compiles successfully with TypeScript

---

## Next Step

Proceed to **Phase 2: Dispatch Mechanism** for actual subagent spawning implementation.