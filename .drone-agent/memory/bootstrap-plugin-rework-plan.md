---
key: bootstrap-plugin-rework-plan
tags:
  - bootstrap
  - plugin
  - plan
  - enablePlugin
  - final
created: 2026-06-23T21:50:04.610Z
updated: 2026-06-23T21:55:50.414Z
---

# Bootstrap Plugin Rework — Final Plan

## Overview
Rename `bootstrap-project` → `bootstrap`, make it a workflow-driven plugin library invoked via `--plugin bootstrap --workflow bootstrap.project`. Add `enablePlugin()` to the engine for in-session plugin enabling. Wire up the `--plugin` CLI flag.

---

## Step 1: Add `enablePlugin()` to the plugin engine
**File:** `drone-agent/src/runtime/plugin-engine.ts`

Add `enablePlugin(pluginId: string): Promise<boolean>` to `DronePluginEngine`:
- Returns `false` if plugin ID not in `pluginMap`
- Returns `true` (idempotent) if already in `enabledPluginIds`
- Adds to `enabledPluginIds`
- Validates non-optional dependencies are enabled (throws if not)
- Calls `registerPlugin(plugin)` to register tools/workflows/hooks/capabilities
- Runs `onPluginsLoaded` and `onSessionStart` hooks immediately (mid-session)
- Returns `true`

**Tests:** `drone-agent/test/plugin-engine.test.ts`
- Enable a default-disabled plugin → tools/workflows available
- Already-enabled plugin → idempotent
- Unknown plugin → returns false
- Missing hard dependency → throws
- Missing optional dependency → succeeds

**Agent:** coder | **Depends on:** nothing

---

## Step 2: Wire `--plugin` CLI flag into config
**File:** `drone-agent/src/index.tsx`

In `main()`, after loading config but before engine creation:
- Support comma-separated: `--plugin bootstrap,lsp,git` → `['bootstrap', 'lsp', 'git']`
- Merge parsed IDs into `resolvedConfig.config.enabledPlugins`:
  - If empty (default), compute default set then add overrides
  - If non-empty (explicit config), append overrides

**Tests:** Extend `drone-agent/test/cli-workflow.test.ts`
- `--plugin bootstrap` → single entry
- `--plugin bootstrap,lsp,git` → three entries
- `--plugin bootstrap --plugin lsp` → backward compat

**Agent:** coder | **Depends on:** nothing

---

## Step 3: Rename `bootstrap-project` → `bootstrap`
**Files:**
- `drone-agent/src/plugins/bootstrap-project.ts` → `drone-agent/src/plugins/bootstrap/index.ts`
- `drone-agent/src/plugins/index.ts` (update import)

Changes:
- id: `'bootstrap-project'` → `'bootstrap'`
- name: `'Bootstrap Project'` → `'Bootstrap'`
- Keep `defaultEnabled: false`
- Keep `analyze` tool (renamed to `bootstrap.analyze`)
- Remove home-directory warning hook (plugin is opt-in now)

**Agent:** coder | **Depends on:** nothing

---

## Step 4: Add `enablePlugin` to `DroneWorkflowContext`
**File:** `drone-core/src/index.ts` — add `enablePlugin: (pluginId: string) => Promise<boolean>` to `DroneWorkflowContext`
**File:** `drone-agent/src/runtime/plugin-engine.ts` — pass `enablePlugin` in workflow context

**Agent:** coder | **Depends on:** Step 1

---

## Step 5: Add `bootstrap.project` workflow
**File:** `drone-agent/src/plugins/bootstrap/index.ts`

Workflow:
1. Run `detectProject()` to analyze cwd
2. Present findings via elicitation
3. Suggest plugins based on detection (git, lsp, exec, etc.)
4. User confirms which to enable
5. Write `enabledPlugins` to project config (persistent)
6. Call `ctx.enablePlugin()` for each chosen plugin (immediate)
7. Return `kickMessage` summarizing setup

**Agent:** coder | **Depends on:** Steps 1, 3, 4

---

## Step 6: Add `bootstrap.user` workflow
**File:** `drone-agent/src/plugins/bootstrap/index.ts`

Workflow:
1. Check for `~/.drone-agent/config.json`
2. Probe LLM providers (Ollama, OpenRouter)
3. Elicit user choice for provider + model
4. Write user config
5. Enable relevant plugins via `ctx.enablePlugin()`
6. Return `kickMessage` summarizing setup

Consider extracting existing first-run logic from `main()` into this workflow.

**Agent:** coder | **Depends on:** Steps 1, 3, 4

---

## Step 7: Update AGENTS.md
- Reflect `bootstrap` rename
- Document `enablePlugin`, `--plugin` flag, `bootstrap.project`/`bootstrap.user` workflows
- Update key files table

**Agent:** coder | **Depends on:** Steps 1–6

---

## Step 8: Integration tests
**File:** `drone-agent/test/bootstrap.test.ts`

- `--plugin bootstrap --workflow bootstrap.project` with mock project dir
- `--plugin bootstrap --workflow bootstrap.user` with mocked providers
- `--plugin bootstrap,lsp,git` enables all three

**Agent:** tester | **Depends on:** Steps 1–6

---

## Execution Order
Steps 1, 2, 3 are independent — can run in parallel.
Step 4 depends on Step 1.
Steps 5, 6 depend on Steps 1, 3, 4.
Step 7 depends on Steps 1–6.
Step 8 depends on Steps 1–6.

## Future (out of scope)
- `bootstrap.standalone-agent` workflow
- `bootstrap.swarm` workflow
- External plugin loading (true hot-loading from disk/npm)