---
key: plan-fix-tool-visibility-filtering
tags:
  - plan
  - tool-visibility
  - persona
  - list-mount
  - bug-fix
created: 2026-08-10T01:25:14.023Z
updated: 2026-08-10T01:25:14.023Z
---

# Plan: Fix Tool Visibility Filtering (default-hidden + persona overlay)

## Summary

When the list-mount pattern was promoted to the runtime level (decision 105), a bug was introduced in the `runtime__list_tools` meta-tool: it hardcodes `defaultHidden: false` on every descriptor it passes to the persona capability's `getFilteredTools()`. This breaks the **default visibility layer** entirely — default-hidden tools (e.g. all `terminal__*` tools) are never filtered out of `runtime__list_tools` results, so they are discoverable and mountable by every persona. The user observed this concretely: the terminal plugin was available to all personas and the LLM kept misusing it, forcing them to disable the plugin.

The correct behavior: the composition of **default visibility** (hide `defaultHidden` tools) and **persona-level tool visibility** (the active persona's `allowedTools` glob overlay) must filter both (a) the list returned by `runtime__list_tools` and (b) the actual mounted tool list sent to the LLM.

## Root Cause

`drone-agent/src/runtime/plugin-engine.ts`, `runtime__list_tools` execute function:

```typescript
const descriptors = tools.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: includeSchemas ? ... : undefined,
  defaultHidden: false,   // ← BUG: always false
}));
```

The persona plugin's `getFilteredTools()` (in `persona/index.ts`) relies on `t.defaultHidden` to hide default-hidden tools when no persona is active or when a persona has no `allowedTools`. Since it's always `false`, those tools are never filtered.

The **mounted-list path** (`getLlmTools()` in `conversation-service.ts`) already passes real `defaultHidden` (from `ToolRegistry.listMounted()`) to `getFilteredTools()`, so it works when the persona plugin is enabled. However, when the persona plugin is disabled entirely, `getLlmTools()` returns all mounted tools unfiltered (no default-hidden fallback), which is inconsistent with the `/tools` slash command (which already does `mountedTools.filter(t => !t.defaultHidden)` when no persona).

## Files to Modify

### 1. `drone-agent/src/runtime/plugin-engine.ts` — fix `runtime__list_tools`

Replace the hardcoded `defaultHidden: false` mapping. Always build full descriptors (which carry the real `defaultHidden` from the registry), apply persona filtering, then strip schemas for the response when `includeSchemas` is false. Add a default-hidden fallback when no persona capability exists.

```typescript
execute: async input => {
  const pluginFilter =
    typeof input.plugin === 'string' ? input.plugin : undefined;
  const includeSchemas = input.includeSchemas === true;

  // Always build full descriptors (with real defaultHidden) for filtering.
  let descriptors = toolRegistry.listUnmountedWithSchemas(pluginFilter);

  // Filter by persona visibility (default-hidden + allowedTools overlay).
  const personaCap = capabilities.get('persona') as
    | {
        getFilteredTools: (
          tools: DroneToolDescriptor[]
        ) => DroneToolDescriptor[];
      }
    | undefined;
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

  return JSON.stringify({ toolCount: tools.length, tools }, null, 2);
};
```

### 2. `drone-agent/src/runtime/conversation-service.ts` — default-hidden fallback in `getLlmTools`

Add the same default-hidden fallback used by `/tools` when no persona capability is present:

```typescript
function getLlmTools(): DroneToolDescriptor[] {
  const allTools = engine.listTools();
  const personaCap = engine.getCapability<{
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  }>('persona');
  return personaCap
    ? personaCap.getFilteredTools(allTools)
    : allTools.filter(t => !t.defaultHidden);
}
```

## Tests

### 3. `drone-agent/test/plugin-engine.test.ts` — regression tests for `runtime__list_tools`

Add tests using `createTestPlugin` with a `capability` offering a persona `getFilteredTools` (import `filterByGlobPatterns` from `drone-core` for the allowedTools case):

- **default-hidden tool filtered when persona active without allowedTools** — register a persona capability whose `getFilteredTools` filters `!t.defaultHidden`, plus a plugin with one `defaultHidden: true` tool and one normal tool; assert `runtime__list_tools` omits the hidden tool.
- **default-hidden tool filtered when no persona is active** — same persona capability but `getActivePersona()` returns null (or a persona with no allowedTools); assert hidden tool omitted.
- **persona allowedTools can re-include a default-hidden tool** — persona capability whose `getFilteredTools` uses `filterByGlobPatterns(names, ['term__create'])`; assert the hidden tool IS included.
- **default-hidden tool filtered when no persona capability at all** — register only the tool plugin (no persona capability); assert `runtime__list_tools` omits the hidden tool (exercises the new fallback).

### 4. `drone-agent/test/conversation-service.test.ts` — regression tests for the mounted list

Add tests using `createMockEngine` with a `getCapability` override, asserting on `provider.__chatMock.mock.calls[0][0].tools`:

- **default-hidden tool filtered from mounted list when no persona** — tools include one `defaultHidden: true`; assert only the non-hidden tool is sent to `provider.chat()`.
- **persona overlay filters mounted list** — provide a persona capability that filters; assert only allowed tools are sent.

## Validation Criteria

1. **LSP passes** — no type errors in `plugin-engine.ts`, `conversation-service.ts`, or the test files.
2. **`pnpm -r run build` passes** — all packages compile cleanly.
3. **`pnpm -r run lint` passes** — eslint + prettier.
4. **`pnpm -r run test` passes** — all existing tests plus the new regression tests pass.
5. **Manual verification:** with the terminal plugin enabled and a persona active (or no persona), `runtime__list_tools` no longer lists `terminal__*` tools unless the active persona's `allowedTools` explicitly includes them; the mounted tool list sent to the LLM likewise excludes them.
