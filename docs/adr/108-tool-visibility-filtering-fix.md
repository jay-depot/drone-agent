---
tags: [decision, tool-visibility, persona, list-mount, bug-fix]
related: [concepts/default-hidden-tools.md, entities/Persona.md, entities/DronePlugin.md, flows/tool-call-loop.md, decisions/105-runtime-level-list-mount.md]
---

# ADR 108: Fix Tool Visibility Filtering — Honor defaultHidden in runtime__list_tools and mounted list

**Status**: Implemented (commit `100421b`)

## Context

When the list-mount pattern was promoted to the runtime level ([[105-runtime-level-list-mount]]), a bug was introduced in the `runtime__list_tools` meta-tool: it **hardcoded `defaultHidden: false`** on every descriptor it passed to the persona capability's `getFilteredTools()`. This broke the **default visibility layer** entirely — default-hidden tools (e.g. all `terminal__*` tools) were never filtered out of `runtime__list_tools` results, so they were discoverable and mountable by **every** persona. The user observed this concretely: the terminal plugin was available to all personas and the LLM kept misusing it, forcing them to disable the plugin.

The correct behavior is a composition of two layers that must filter both (a) the list returned by `runtime__list_tools` and (b) the actual mounted tool list sent to the LLM:

1. **Default visibility layer** — hide `defaultHidden` tools
2. **Persona-level overlay** — the active persona's `allowedTools` glob patterns

## Root Causes

### 1. `runtime__list_tools` hardcoded `defaultHidden: false`

In `drone-agent/src/runtime/plugin-engine.ts`, the `runtime__list_tools` execute function mapped each unmounted tool descriptor with `defaultHidden: false`, discarding the real flag from the registry. The persona plugin's `getFilteredTools()` relies on `t.defaultHidden` to hide default-hidden tools when no persona is active or when a persona has no `allowedTools`. Since it was always `false`, those tools were never filtered.

### 2. `getLlmTools()` lacked the default-hidden fallback

The **mounted-list path** (`getLlmTools()` in `conversation-service.ts`) already passed real `defaultHidden` (from `ToolRegistry.listMounted()`) to `getFilteredTools()`, so it worked when the persona plugin was enabled. However, when the persona plugin was disabled entirely, `getLlmTools()` returned all mounted tools unfiltered (no default-hidden fallback) — inconsistent with the `/tools` slash command, which already does `mountedTools.filter(t => !t.defaultHidden)` when no persona.

## Decision

### Fix `runtime__list_tools` (plugin-engine.ts)

Always build full descriptors (carrying the real `defaultHidden` from the registry), apply persona filtering, then strip schemas for the response when `includeSchemas` is false. Add a default-hidden fallback when no persona capability exists:

```typescript
// Always build full descriptors (with real defaultHidden) for filtering.
let descriptors = toolRegistry.listUnmountedWithSchemas(pluginFilter);

// Filter by persona visibility (default-hidden + allowedTools overlay).
const personaCap = capabilities.get('persona');
if (personaCap) {
  descriptors = personaCap.getFilteredTools(descriptors);
} else {
  // No persona plugin: honor default visibility by hiding defaultHidden tools.
  descriptors = descriptors.filter(t => !t.defaultHidden);
}

// Build the response, stripping schemas unless requested.
const tools = includeSchemas
  ? descriptors
  : descriptors.map(({ name, description }) => ({ name, description }));
```

### Fix `getLlmTools()` (conversation-service.ts)

Add the same default-hidden fallback when no persona capability is present, matching `/tools`:

```typescript
return personaCap
  ? personaCap.getFilteredTools(allTools)
  : allTools.filter(t => !t.defaultHidden);
```

## Consequences

### Positive

- Default-hidden tools are properly hidden from `runtime__list_tools` for every persona (unless explicitly re-included via `allowedTools`)
- Consistent behavior between `runtime__list_tools`, the mounted list sent to the LLM, and the `/tools` slash command
- The default visibility layer now works as originally intended

### Neutral

- `runtime__list_tools` now always builds full descriptors internally (with schemas) and strips them only at the response boundary — a negligible cost since the schema objects are already in memory

## Tests

Added regression tests in:
- `plugin-engine.test.ts` — 4 tests covering default-hidden filtering with persona active (no allowedTools), no persona active, persona allowedTools re-including a default-hidden tool, and no persona capability at all (exercising the new fallback)
- `conversation-service.test.ts` — 2 tests for the mounted list: default-hidden filtered when no persona present, and persona overlay applied to the mounted list

## Related

- [[concepts/default-hidden-tools]] — The default-hidden concept and `allowedTools` overlay
- [[decisions/105-runtime-level-list-mount]] — The runtime-level list-mount that introduced this bug
- [[flows/tool-call-loop]] — `getLlmTools()` in the conversation service
