---
key: plan-persona-always-visible-runtime-tools
tags:
  - plan
  - drone-agent
  - tools
  - persona
  - tool-visibility
  - runtime-meta-tools
  - alwaysVisible
  - preventUnmount
created: 2026-10-26T00:38:39.402Z
updated: 2026-10-26T01:16:04.361Z
---

# Plan: engine-owned tools stay visible and cannot be unmounted (`alwaysVisible` + `preventUnmount`)

## 1. Summary

### 1.1 The defect

A persona can lose the three engine meta-tools. The meta-tools are `runtime__list_tools`, `runtime__mount_tool`, and `runtime__unmount_tool`. The trigger is a persona `allowedTools` list that does not match `runtime__*`. When this happens, the persona cannot list, mount, or unmount any tool.

The meta-tools stay mounted in the tool registry. The defect is a visibility defect only. It is not an unmount defect.

The visibility filter is `getFilteredTools` in `drone-agent/src/plugins/persona/index.ts`. Four consumers use this filter:

1. `getLlmTools` in `drone-agent/src/runtime/conversation-service.ts` (the tool list that the LLM receives).
2. The `/tools` built-in slash command in `drone-agent/src/runtime/builtin-commands.ts`.
3. The `runtime__list_tools` meta-tool in `drone-agent/src/runtime/plugin-engine.ts`.
4. The MCP server-count fragment and the TUI status-bar tool count.

The `premountedTools` union (ADR 109) is the only current workaround. It force-includes the premounted names in `getFilteredTools`.

### 1.2 The fix

Two new flags on a tool definition:

- `alwaysVisible` — exempts the tool from the **inclusion** patterns of `allowedTools`. An explicit `!` **exclusion** pattern still hides the tool.
- `preventUnmount` — the engine refuses to unmount the tool.

Add a guard to the engine function `unmountTracked`. The guard reads `preventUnmount`. The guard is the single enforcement point. All unmount paths pass through it.

The engine reports a refused unmount truthfully. The LLM must not believe that it unmounted a tool that the engine kept.

### 1.3 Why this design

`filterByGlobPatterns` (`drone-core/src/utils.ts`) already separates inclusion patterns from `!` exclusion patterns. The fix uses this. A `!` exclusion stays authoritative. A normal inclusion pattern no longer reaches an `alwaysVisible` tool.

All four consumers route through `getFilteredTools`. Therefore one change fixes all four. This keeps one enforcement point.

### 1.4 Locked decisions

| #   | Decision                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- |
| 1   | The trigger is the `allowedTools` visibility filter. It is not an unmount.                         |
| 2   | Add a declarative `alwaysVisible` flag. It exempts a tool from `allowedTools` inclusion patterns.  |
| 3   | Add a `preventUnmount` flag. Add an unmount guard that reads it.                                   |
| 4   | Two flags. The two behaviours are independent.                                                     |
| 5   | Exclusions win over `alwaysVisible`. `allowedTools: ['!runtime__*']` hides the meta-tools.         |
| 6   | Do not change the `premountedTools` union. It keeps its current force-include behaviour (ADR 109). |
| 7   | The guard lives in `unmountTracked`. The refusal is unconditional. The guard logs a warning.       |
| 8   | A refused unmount is reported truthfully to the LLM and to the human.                              |

### 1.5 Non-goals

- Do not change `ToolRegistry.mount()`. It returns `undefined` for both "unknown tool" and "already mounted". This makes `applyToolPremount` log a false `premountedTools: unknown tool` warning. This is a cosmetic, pre-existing defect. Log it as a follow-up insight.
- Do not change the `runtime__unmount_tool` result for an unknown tool. It keeps its current `success: true`.
- Do not unify the exclusion-versus-premount semantics.
- Do not add `alwaysVisible` to the portable-context export schema.

---

## 2. Step-by-step plan

Each step names its agent. Do the steps in the listed order. The order matches the dependency chain: types first, then the registry, then the engine, then the persona filter, then the docs, then the tests, then the final check.

### Step 1 — coder: add the two flags to `DroneToolDefinition`

File: `drone-core/src/plugin-system.ts`.

In the `DroneToolDefinition` type, after `defaultHidden`, add:

```ts
  /**
   * If true, this tool is exempt from the active persona's `allowedTools`
   * inclusion patterns. An explicit `!` exclusion pattern still hides the
   * tool. The engine sets this on its own meta-tools.
   */
  alwaysVisible?: boolean;
  /**
   * If true, the engine refuses to unmount this tool. The engine owns the
   * tool and guarantees its presence. The unmount guard in `unmountTracked`
   * reads this flag.
   */
  preventUnmount?: boolean;
```

### Step 2 — coder: add `alwaysVisible` to `DroneToolDescriptor`

File: `drone-core/src/session-types.ts`.

In the `DroneToolDescriptor` type, after `defaultHidden`, add:

```ts
  /**
   * Exempt from persona `allowedTools` inclusion patterns. Propagated from
   * `DroneToolDefinition.alwaysVisible` through the tool registry.
   */
  alwaysVisible?: boolean;
```

Note: `preventUnmount` stays on the definition only. The engine guard reads the definition. The descriptor does not need it.

### Step 3 — coder: add the unmount-result type

File: `drone-core/src/plugin-system.ts`.

Add a new exported type:

```ts
/**
 * Result of an unmount request. `unmounted` is false when the engine refused
 * the request. `reason` explains the refusal.
 */
export type DroneToolUnmountResult = {
  unmounted: boolean;
  reason?: string;
};
```

Export it from `drone-core/src/index.ts`.

### Step 4 — coder: propagate `alwaysVisible` in the registry

File: `drone-core/src/tool-registry.ts`.

Add `alwaysVisible: entry.definition.alwaysVisible,` to each descriptor that the class builds. There are three such places: `listAll`, `listMounted`, and `listUnmountedWithSchemas`.

### Step 5 — coder: set the flags on the meta-tools

File: `drone-agent/src/runtime/plugin-engine.ts`, function `registerRuntimeMetaTools`.

Change the `metaTools` array element type to `DroneToolDefinition`. Add `alwaysVisible: true` and `preventUnmount: true` to each of the three meta-tool objects.

### Step 6 — coder: add the guard to `unmountTracked`

File: `drone-agent/src/runtime/plugin-engine.ts`.

Change `unmountTracked` to return a `DroneToolUnmountResult`. Add the guard first:

```ts
function unmountTracked(
  canonicalName: string,
  opts?: { announce?: boolean }
): DroneToolUnmountResult {
  const def = toolRegistry.get(canonicalName);
  if (def?.preventUnmount) {
    const reason = `${canonicalName} is an engine-owned tool and cannot be unmounted.`;
    logger.warn(`refusing to unmount ${canonicalName}: engine-owned tool`);
    return { unmounted: false, reason };
  }
  toolRegistry.unmount(canonicalName);
  logToolChange('unmount', canonicalName);
  if (opts?.announce === false) {
    everMountedTools.delete(canonicalName);
  } else {
    scheduleUnavailableNotice();
  }
  return { unmounted: true };
}
```

### Step 7 — coder: make the unmount surface truthful

Files:

- `drone-core/src/plugin-system.ts` — change `DronePluginRegistration.unmountTool`, `DroneSlashCommandContext.engine.unmountTool`, and `DronePluginEngine.unmountTool` to return `DroneToolUnmountResult`.
- `drone-agent/src/runtime/plugin-engine.ts` — the engine implementation of `unmountTool` returns the result of `unmountTracked`. The registration implementation also returns it.
- `drone-agent/src/interactive.ts` — the CLI engine subset passes the result through.

Change the `runtime__unmount_tool` execute function:

```ts
const outcome = unmountTracked(toolName, { announce: false });
if (!outcome.unmounted) {
  return JSON.stringify(
    { success: false, tool: toolName, error: outcome.reason },
    null,
    2
  );
}
return JSON.stringify({ success: true, tool: toolName }, null, 2);
```

Change the `/tool unmount <name>` handler in `drone-agent/src/runtime/builtin-commands.ts`:

```ts
const outcome = ctx.engine.unmountTool(name);
if (!outcome.unmounted) {
  ctx.logger.error(`Cannot unmount ${name}: ${outcome.reason}`);
} else {
  ctx.logger.info(`Unmounted ${name}.`);
}
return true;
```

The `/tool unmount --all` path collects the result of each `ctx.engine.unmountTool(t.name)` call and reports the tools that were actually unmounted, listing any refused tools separately as skipped. It still filters the `runtime__` prefix.

### Step 8 — coder: exempt `alwaysVisible` tools from inclusion patterns

File: `drone-agent/src/plugins/persona/index.ts`.

Do not add `matchGlob` to the `drone-core` import. The corrected filter uses only `filterByGlobPatterns`, which already separates inclusion patterns from `!` exclusion patterns.

Replace `getFilteredTools` with:

```ts
function getFilteredTools(
  allTools: DroneToolDescriptor[]
): DroneToolDescriptor[] {
  const premountedNames = new Set(expandPremountedCanonical());
  const patterns = activePersona?.allowedTools;
  const names = allTools.map(t => t.name);
  const includedByAllowedTools = patterns
    ? new Set(filterByGlobPatterns(names, patterns))
    : undefined;
  // filterByGlobPatterns with only exclusion patterns returns every name
  // no `!` pattern excludes, so it yields the non-excluded set directly.
  const notExcluded = patterns
    ? new Set(
        filterByGlobPatterns(
          names,
          patterns.filter(p => p.startsWith('!'))
        )
      )
    : undefined;

  return allTools.filter(t => {
    if (premountedNames.has(t.name)) return true;
    if (t.alwaysVisible) return notExcluded?.has(t.name) ?? true;
    if (!includedByAllowedTools) return !t.defaultHidden;
    return includedByAllowedTools.has(t.name);
  });
}
```

There is no separate `isToolExcluded` helper. The premount check runs first, so a premounted name stays visible even when a `!` exclusion matches it (ADR 109). This keeps the `premountedTools` union unchanged. It keeps `defaultHidden` behaviour unchanged.

### Step 9 — coder: update the doc comments

- `drone-core/src/persona-types.ts` — in the `allowedTools` doc, state that tools with `alwaysVisible` are exempt from inclusion patterns, and that `!` exclusions still apply.
- `docs/agents/mcp-plugin.md` — no change needed. Confirm only.

### Step 10 — coder: write the ADR

New file: `docs/adr/262-engine-owned-tools-always-visible-and-protected.md`.

Record: the defect, the two flags, the exclusion-still-wins rule, the single guard in `unmountTracked`, the truthful unmount result, and the rejected alternatives. Add a row to `docs/adr/index.md`. Use the existing table format and put the row at the top of the table.

### Step 11 — tester: add the unit tests

Tests to add:

1. `drone-core/test/tool-registry.test.ts` — `listAll`, `listMounted`, and `listUnmountedWithSchemas` propagate `alwaysVisible` from the definition.
2. `drone-agent/test/plugin-engine.test.ts` — `runtime__unmount_tool` on `runtime__mount_tool` returns `success: false` and the tool stays mounted.
3. `drone-agent/test/persona-premount.test.ts` — or a new `persona-visibility.test.ts`:
   - An `alwaysVisible` tool survives an `allowedTools` list that does not match it.
   - `allowedTools: ['!runtime__*']` hides the alwaysVisible meta-tools.
   - The `premountedTools` union behaviour is unchanged.
   - A real-path test: with `allowedTools: ['file__read']`, `getFilteredTools(engine.listTools())` keeps the three runtime meta-tools (mounted tools, not all tools).
   - The premount union force-includes a premounted name even when a `!` exclusion matches it.
4. `drone-agent/test/builtin-commands.test.ts` — `/tool unmount runtime__mount_tool` prints the refusal message and keeps the tool mounted. Update the existing `unmountTool` mock to return a `DroneToolUnmountResult`.

Sweep all test mocks of `unmountTool`. The mock must return `{ unmounted: true }`.

### Step 12 — reviewer: review against this plan

Check each decision in section 1.4 against the code. Check that all four `getFilteredTools` consumers behave correctly. Check that the exclusion rule holds. Check that no other `unmountTool` implementer or caller remains.

### Step 13 — all agents: check the work against the validation criteria

Run every check in section 3. Do not report the job as done until all checks pass.

---

## 3. Validation criteria

All of the following must pass.

1. **LSP** — no errors and no warnings in the workspace.
2. **Build** — `pnpm -r run build` passes with zero errors.
3. **Lint** — `pnpm run lint` passes with zero errors. This includes ESLint and Prettier.
4. **Tests** — `pnpm run test` passes. All new tests pass. All existing tests pass.
5. **Behaviour — inclusion exemption** — a persona with `allowedTools: ['file__*']` still sees `runtime__list_tools`, `runtime__mount_tool`, and `runtime__unmount_tool`.
6. **Behaviour — exclusion wins** — a persona with `allowedTools: ['!runtime__*']` does not see the three meta-tools.
7. **Behaviour — unmount refusal** — `runtime__unmount_tool` on a `preventUnmount` tool returns `success: false` with a reason. The tool stays mounted.
8. **Behaviour — human path** — `/tool unmount runtime__mount_tool` prints a refusal and keeps the tool mounted.
9. **Behaviour — no regression** — the `premountedTools` union and the `defaultHidden` filter behave as before.
10. **Docs** — ADR 262 exists and has a row in `docs/adr/index.md`.

---

## 4. Follow-up insights to log

Log these with `self-improvement__insight`. Do not fix them in this change.

- `ToolRegistry.mount()` returns `undefined` for an already-mounted tool. `applyToolPremount` reads this as "unknown tool" and logs a false warning.
- `runtime__unmount_tool` returns `success: true` for an unknown tool name.
- The premount union ignores `!` exclusions. The alwaysVisible exemption does not.
