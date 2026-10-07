---
tags: [decision, bugfix, persona, cli, swarm]
related: [entities/Persona.md, flows/plugin-lifecycle.md, concepts/broker-provider.md, architecture/plugin-system.md, concepts/subagent.md]
---

# 026: Persona CLI Flag Fix — `_runtime` Capability and Hook Ordering

**Summary**: The `--persona` CLI flag was broken due to two bugs: the `_runtime` capability was gated behind the subagent plugin's `offer()` callback (which never fires), and persona activation ran in `onPluginsLoaded` before swarm providers could register. Fixed by setting `_runtime` unconditionally in the engine and moving activation to `onSessionStart`.

## Context

The `--persona` CLI flag (and its `DRONE_PERSONA` env var fallback) was intended to let users start `drone-agent` with a specific persona loaded, overriding `config.activePersona`. The flag was parsed in `cli.ts` and passed to the engine via `runtimeOptions.persona`, but it never actually activated the persona.

Additionally, the flag could only select personas from local file-based providers (project/user), not from swarm providers (beacon/coordinator), because swarm providers register after the persona plugin's `onPluginsLoaded` hook fires.

## Root Causes

### Bug 1: `_runtime` capability never set

In `plugin-engine.ts`, the `_runtime` capability (which carries the `--persona` value) was only set **inside the subagent plugin's `offer()` callback**:

```ts
offer: capability => {
  capabilities.set(plugin.metadata.id, capability);
  if (plugin.metadata.id === 'subagent') {  // ← only when subagent offers
    capabilities.set('_runtime', { persona: runtimeOptions?.persona, ... });
  }
},
```

The subagent plugin **never calls `offer()`** — it only calls `registerTool()` and `registerPromptFragment()`. So `_runtime` was never populated, and the persona plugin's `registration.request<{ persona?: string }>('runtime')` always returned `undefined`.

### Bug 2: Persona activation runs before swarm providers register

The persona plugin activated the persona in its `onPluginsLoaded` hook. The swarm plugin also registers its persona providers in its own `onPluginsLoaded` hook. Since the persona plugin is registered first (it's earlier in the plugin list), its `onPluginsLoaded` fires **before** the swarm plugin's, so swarm-provided personas weren't available yet.

## Decision

### Fix 1: Move `_runtime` out of subagent's `offer` callback

**File:** `drone-agent/src/runtime/plugin-engine.ts`

The `_runtime` capability is now set **unconditionally** after all plugins are registered in the engine's `initialize()` method:

```ts
// After all plugins are registered, expose runtime options
capabilities.set('_runtime', {
  subagentId: runtimeOptions?.subagentId,
  persona: runtimeOptions?.persona,
  isSubagent: !!runtimeOptions?.subagentId,
});
```

This ensures `_runtime` is always available regardless of which plugins are enabled or whether they call `offer()`.

### Fix 2: Move persona activation to `onSessionStart`

**File:** `drone-agent/src/plugins/persona/index.ts`

The persona activation logic was moved from `onPluginsLoaded` to `onSessionStart`:

- **`onPluginsLoaded`** now only calls `reloadPersonas()` and logs the count — no activation.
- **`onSessionStart`** now contains the activation logic: runtime option (`--persona`) → `config.activePersona` → warn if not found.

This works because `onSessionStart` runs after **all** `onPluginsLoaded` hooks have completed, so swarm providers (which register in their own `onPluginsLoaded`) are already available.

## Consequences

- **Positive**: `--persona <id>` now works correctly
- **Positive**: `--persona` can select personas from any provider (local file, swarm beacon, swarm coordinator)
- **Positive**: `DRONE_PERSONA` env var fallback also works
- **Positive**: `config.activePersona` still works as a fallback when `--persona` is not provided
- **Positive**: `--persona` takes precedence over `config.activePersona`
- **Positive**: Missing persona IDs log a warning instead of crashing
- **Positive**: The `_runtime` capability is now a general-purpose mechanism for passing runtime options to any plugin, not just the subagent plugin
- **Positive**: The hook ordering guarantee (`onSessionStart` after all `onPluginsLoaded`) is now explicitly relied upon for cross-plugin coordination

## Related

- [Persona](../../drone-core/src/domain-types.ts) — Persona definition and capabilities
- plugin-lifecycle — Hook ordering and lifecycle
- broker-provider — Broker + provider pattern
- [plugin-system](002-plugin-system.md) — Plugin architecture
- subagent — Subagent spawning (also uses `_runtime`)
