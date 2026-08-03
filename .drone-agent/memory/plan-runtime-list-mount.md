---
key: plan-runtime-list-mount
tags:
  - plan
  - list-mount
  - runtime
  - completed
created: 2026-08-03T18:33:13.870Z
updated: 2026-08-03T19:12:32.697Z
---

# Plan: Runtime-Level List-Mount for All Tools

## Summary

Promote the ad-hoc, per-plugin list-mount pattern (currently implemented independently in file, git, lsp, swarm, and MCP plugins) to a single runtime-level mechanism. All tools are registered with the engine but start **unmounted**. Only three runtime meta-tools (`runtime__list_tools`, `runtime__mount_tool`, `runtime__unmount_tool`) are always available. The LLM must explicitly mount tools before calling them. Persona visibility filtering (`allowedTools`, `defaultHidden`) is wired into the listing so the LLM only sees tools it's allowed to use.

## Status: COMPLETED

All 15 steps have been executed and validated. The implementation is committed on branch `feat/list-mount-alll-the-things` (commit `7a5e058`).

## What was done

1. **Created `ToolRegistry` class** in `drone-core/src/tool-registry.ts` — central registry replacing both the engine's internal `Map<string, DroneToolDefinition>` and the per-plugin `ToolMountingCache` instances. Tracks mount state per tool.

2. **Modified `DronePluginEngine`** to use `ToolRegistry` — swapped the internal map, updated all methods (`registerTool`, `getTool`, `executeTool`, `listTools`, `unregisterPluginTools`, `unregisterTool`).

3. **Registered runtime meta-tools** — `runtime__list_tools({ plugin?, includeSchemas? })`, `runtime__mount_tool({ tool })`, `runtime__unmount_tool({ tool })` are always available. Persona filtering is applied in `runtime__list_tools`.

4. **Injected enabled plugin list** into system prompt via `RuntimeFlagRegistry` — renders as `plugins: exec, persona, memory, file, git, ...` so the LLM knows what plugins are available.

5. **Updated `RuntimeFlagRegistry`** — replaced the old `list-mount` explainer with a unified tool management explainer referencing the runtime meta-tools.

6-10. **Cleaned up plugins** — file, git, lsp, swarm, and MCP plugins all had their `list_tools`/`mount_tool`/`unmount_tool` meta-tools and `ToolMountingCache` usage removed. They now register tools directly with `registration.registerTool()`.

11. **Removed `ToolMountingCache` class** — deleted the file and its export.

12-14. **Verified conversation service, TUI components** — no changes needed. Updated `/tools` slash command description.

15. **Validation** — LSP, typecheck, build, lint, and all 108 test files pass.

## Key design decisions

- All tools start unmounted. Only the three runtime meta-tools are always available.
- MCP tools are flattened into the global tool pool (e.g., `mcp__searxng__search`).
- `runtime__list_tools` supports `plugin` filter and `includeSchemas` flag.
- Persona `allowedTools` filtering is applied in `runtime__list_tools`.
- The `DronePluginRegistration` interface gained `mountTool` and `unmountTool` methods for plugins that need to manage their own tool lifecycle (e.g., MCP plugin's meta-tools).
