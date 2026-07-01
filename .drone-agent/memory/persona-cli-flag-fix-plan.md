---
key: persona-cli-flag-fix-plan
tags:
  - plan
  - persona
  - cli
  - bugfix
  - swarm
created: 2026-07-01T00:42:10.399Z
updated: 2026-07-01T00:42:10.399Z
---

# Plan: Fix `--persona` CLI Flag + Swarm Persona Support

## Summary

Fix the `--persona` CLI flag so it actually works, and make it able to select personas from any provider (local file-based or swarm), not just local ones.

## Root Cause Analysis

### Bug 1: `_runtime` capability is never set

In `drone-agent/src/runtime/plugin-engine.ts` (lines 440-443), the `_runtime` capability (which carries the `--persona` value) is only set **inside the subagent plugin's `offer()` callback**:

```ts
offer: capability => {
  capabilities.set(plugin.metadata.id, capability);
  if (plugin.metadata.id === 'subagent') {  // ← only when subagent offers
    capabilities.set('_runtime', { persona: runtimeOptions?.persona, ... });
  }
},
```

But the subagent plugin **never calls `offer()`** — it only calls `registerTool()` and `registerPromptFragment()`. So `_runtime` is never populated, and the persona plugin's `registration.request<{ persona?: string }>('runtime')` always returns `undefined`.

### Bug 2: Persona activation runs before swarm providers are registered

Even if Bug 1 were fixed, the persona plugin activates the persona in its `onPluginsLoaded` hook. The swarm plugin also registers its persona providers in its own `onPluginsLoaded` hook. Since the persona plugin is registered first (it's earlier in the plugin list), its `onPluginsLoaded` fires **before** the swarm plugin's, so swarm-provided personas aren't available yet.

The fix is to move persona activation from `onPluginsLoaded` to `onSessionStart` in the persona plugin, which runs after all `onPluginsLoaded` hooks have completed.

## Step 1: Move `_runtime` capability out of subagent's `offer` callback

**File:** `drone-agent/src/runtime/plugin-engine.ts`

**What:** The `_runtime` capability should be set unconditionally during engine initialization, not conditionally inside the subagent plugin's `offer()` callback.

**Changes:**

1. Remove the `if (plugin.metadata.id === 'subagent')` block from the `offer` callback (lines 440-443).
2. After the `initialize` function registers all plugins (after the `for (const plugin of sortedPlugins)` loop at line 507), set `_runtime` unconditionally:

```ts
// After all plugins are registered, expose runtime options
capabilities.set('_runtime', {
  subagentId: runtimeOptions?.subagentId,
  persona: runtimeOptions?.persona,
  isSubagent: !!runtimeOptions?.subagentId,
});
```

This ensures `_runtime` is always available regardless of which plugins are enabled.

## Step 2: Move persona activation from `onPluginsLoaded` to `onSessionStart`

**File:** `drone-agent/src/plugins/persona/index.ts`

**What:** The persona activation logic (determining which persona to activate and calling `activatePersona()`) currently lives in the `onPluginsLoaded` hook. Move it to `onSessionStart` so that all persona providers (including swarm's, which register in their own `onPluginsLoaded`) are already registered before activation runs.

**Changes:**

1. In the `onPluginsLoaded` hook (lines 229-270), remove the persona activation block (lines 240-270) — keep only the `reloadPersonas()` call and the "no persona files" check.
2. Add a new `onSessionStart` hook that contains the activation logic:

```ts
registration.hooks.onSessionStart(async () => {
  const all = getAllPersonas();
  // Determine which persona to activate: runtime option (--persona CLI flag)
  // takes precedence over config.activePersona
  let personaToActivate: string | null = null;

  const runtime = registration.request<{ persona?: string }>('runtime');
  if (runtime?.persona) {
    personaToActivate = runtime.persona;
  }

  if (!personaToActivate && config.activePersona) {
    personaToActivate = config.activePersona;
  }

  if (personaToActivate) {
    const activated = await activatePersona(personaToActivate);
    if (activated) {
      registration.logger.info(
        `active persona: ${activated.name} (${activated.id})`
      );
    } else {
      registration.logger.warn(`persona "${personaToActivate}" not found`);
    }
  }
});
```

## Step 3: Add tests

**File:** `drone-agent/test/persona-cli-flag.test.ts` (new file)

**What:** Add tests that verify:

1. The `_runtime` capability is available even when the subagent plugin is not enabled.
2. The `--persona` flag value is correctly passed through to the persona plugin.
3. A persona from a swarm provider (registered after the persona plugin's `onPluginsLoaded`) can be activated via `--persona`.

## Step 4: Verify with LSP and tests

Run `pnpm typecheck` and `pnpm test` to ensure no regressions.

## Validation Criteria

- `pnpm typecheck` passes with no errors
- `pnpm test` passes (all existing tests + new tests)
- `pnpm lint` passes
- The `--persona <id>` CLI flag activates a persona from any provider (local file, swarm beacon, swarm coordinator)
- The `DRONE_PERSONA` env var fallback also works
- `config.activePersona` still works as a fallback when `--persona` is not provided
- Persona activation from `--persona` works even when the swarm plugin is enabled and the persona lives on the beacon/coordinator

## Dependencies

- Step 1 must be done before Step 2 (the `_runtime` capability must exist for the persona plugin to read it)
- Step 3 can be done after Steps 1 and 2
- Step 4 is the final verification

## Order of Execution

1. **Coder** implements Step 1 (move `_runtime` out of subagent's `offer`)
2. **Coder** implements Step 2 (move persona activation to `onSessionStart`)
3. **Coder** implements Step 3 (add tests)
4. **Reviewer** reviews all changes
5. **Tester** runs Step 4 (typecheck, test, lint)
