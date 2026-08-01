---
key: plan-fix-systemprompt-runtime-flags
tags:
  - plan
  - systemprompt
  - runtime-flags
created: 2026-08-01T21:11:34.637Z
updated: 2026-08-01T21:11:34.637Z
---

# Plan: Fix /systemprompt to show runtime flags

## Summary

The `/systemprompt` slash command in `builtin-commands.ts` manually assembles its output from `config.systemPrompt` + `renderPromptFragments()`, bypassing `buildSystemMessages()` from the context budget service. This means the runtime flags block (which includes the list-mount pattern explainer) is sent to the LLM but invisible to the user when they run `/systemprompt`.

The fix: add `buildSystemMessages` to the engine interface, wire it through from the budget service in `index.tsx`, and have the `/systemprompt` handler use it instead of manually assembling the pieces.

## Implementation Steps

### Step 1: Add `buildSystemMessages` to the engine interface

**File: `drone-agent/src/runtime/plugin-engine.ts`**

Add to the `DronePluginEngine` type (near `getRuntimeFlags`, around line 120):

```typescript
/** Build the full system messages as sent to the LLM (config prompt + runtime flags + prompt fragments). */
buildSystemMessages: () => Promise<DroneChatMessage[]>;
```

Add to `CreateDronePluginEngineOptions`:

```typescript
buildSystemMessages?: () => Promise<DroneChatMessage[]>;
```

In the return object (around line 660), add a fallback that mirrors the current manual assembly:

```typescript
buildSystemMessages: async () => {
  if (!buildSystemMessages) {
    const config = getConfig();
    const fragments = await renderPromptFragments();
    const base: DroneChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
    ];
    for (const content of fragments) {
      base.push({ role: 'system', content });
    }
    return base;
  }
  return buildSystemMessages();
},
```

### Step 2: Wire `buildSystemMessages` in `index.tsx`

**File: `drone-agent/src/index.tsx`**

In the `createDronePluginEngine` call (around line 148), pass the budget service's `buildSystemMessages`:

```typescript
const engine = createDronePluginEngine({
  plugins: allPlugins,
  config: resolvedConfig.config,
  logger,
  runtimeOptions: {
    subagentId: invocation.options.subagentId,
    persona: invocation.options.persona,
  },
  buildSystemMessages: () => budgetService.buildSystemMessages(),
});
```

### Step 3: Update the `/systemprompt` handler

**File: `drone-agent/src/runtime/builtin-commands.ts`**

Replace the handler body (lines 141-155) with:

```typescript
handler: async (ctx: DroneSlashCommandContext) => {
  const systemMessages = await ctx.engine.buildSystemMessages?.() ?? [];
  const lines: string[] = ['System Messages:'];
  for (const msg of systemMessages) {
    lines.push('────────────────────────────────────────');
    lines.push(msg.content);
  }
  ctx.logger.info(lines.join('\n'));
  return true;
},
```

### Step 4: Add `buildSystemMessages` to `DroneSlashCommandContext.engine`

**File: `drone-core/src/plugin-system.ts`**

Add to the `engine` field in `DroneSlashCommandContext` (around line 290, near `renderPromptFragments`):

```typescript
/** Build the full system messages as sent to the LLM. */
buildSystemMessages?: () => Promise<DroneChatMessage[]>;
```

Import `DroneChatMessage` from `./session-types.js` if not already imported.

### Step 5: Update tests

**File: `drone-agent/test/systemprompt.test.tsx`**

- Update the test mock to provide `buildSystemMessages` on the engine object
- Verify the output includes the runtime flags block when flags are set
- Verify the output still includes the config system prompt and all plugin prompt fragments

**Validation**: All tests pass with `pnpm -r run test`.

## Validation Criteria

- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run test` passes (all packages)
- [ ] LSP diagnostics show no errors or warnings
- [ ] `/systemprompt` output includes the runtime flags block (list-mount explainer + active plugins)
- [ ] `/systemprompt` output still includes config system prompt and all plugin prompt fragments
- [ ] When no runtime flags are set, `/systemprompt` output is unchanged from before
- [ ] The `buildSystemMessages` fallback in the engine (when not provided) produces the same output as the old manual assembly