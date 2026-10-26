# 262. Engine-owned tools stay always visible and cannot be unmounted

- Status: Accepted
- Date: 2026-10-26

## Context

The engine owns three meta-tools: `runtime__list_tools`, `runtime__mount_tool`,
and `runtime__unmount_tool`. They are the only way the LLM can discover and
manage every other tool.

A persona can lose all three. The tool visibility filter `getFilteredTools`
(`drone-agent/src/plugins/persona/index.ts`) applies the persona's `allowedTools`
glob patterns to the mounted tool list. When a persona declares an `allowedTools`
list that does not match `runtime__*`, the meta-tools drop out of the tool list
the LLM receives. The persona can then no longer list, mount, or unmount any
tool.

The meta-tools stay mounted in the `ToolRegistry`. The defect is a visibility
defect. It is not an unmount defect.

Four consumers use `getFilteredTools`:

1. `getLlmTools` (`drone-agent/src/runtime/conversation-service.ts`) — the tool
   list the LLM receives.
2. The `/tools` built-in slash command (`drone-agent/src/runtime/builtin-commands.ts`).
3. The `runtime__list_tools` meta-tool (`drone-agent/src/runtime/plugin-engine.ts`).
4. The MCP server-count fragment and the TUI status-bar tool count.

The `premountedTools` union (ADR [109](109-persona-level-tool-premounting.md)) is
the current workaround. It force-includes the premounted names in
`getFilteredTools`. It does not cover the engine's own tools.

## Decision

### D1 — Two independent flags

`DroneToolDefinition` gains two optional flags:

- `alwaysVisible` — the tool is exempt from the active persona's `allowedTools`
  **inclusion** patterns.
- `preventUnmount` — the engine refuses to unmount the tool.

The two behaviours are independent. A tool can have either, both, or neither.

### D2 — `alwaysVisible` propagates to the descriptor

`DroneToolDescriptor` gains `alwaysVisible`, set from the definition in each of
`ToolRegistry.listAll`, `listMounted`, and `listUnmountedWithSchemas`. The
visibility filter reads descriptors, so the flag must travel with them.

`preventUnmount` stays definition-only. The unmount guard reads the definition
through `ToolRegistry.get`, so the descriptor does not need it.

### D3 — Exclusion still wins

A `!` exclusion pattern in `allowedTools` hides an `alwaysVisible` tool.
`allowedTools: ['!runtime__*']` hides the meta-tools. Exclusions are
authoritative; the `alwaysVisible` exemption applies to inclusion patterns only.
`filterByGlobPatterns` (`drone-core/src/utils.ts`) already separates the two
kinds of pattern.

One exception predates this change: a **premounted** tool is force-included even
when a `!` exclusion matches it (ADR [109](109-persona-level-tool-premounting.md)).
That behaviour is deliberately left unchanged here.

### D4 — One filter enforces visibility

`getFilteredTools` is the single visibility enforcement point. The new order is:

1. A premounted tool is included, even past a `!` exclusion (ADR
   [109](109-persona-level-tool-premounting.md), unchanged).
2. Otherwise, a `!` exclusion pattern wins — the tool is hidden.
3. Otherwise, an `alwaysVisible` tool is included.
4. Otherwise, no `allowedTools` patterns — include when not `defaultHidden`.
5. Otherwise, patterns present — include when an inclusion pattern matches.

All four consumers route through this one function, so one change fixes all
four.

### D5 — One guard enforces `preventUnmount`

All unmount paths pass through engine function `unmountTracked`. It gains the
guard as its first statement:

```ts
const def = toolRegistry.get(canonicalName);
if (def?.preventUnmount) {
  const reason = `${canonicalName} is an engine-owned tool and cannot be unmounted.`;
  logger.warn(`refusing to unmount ${canonicalName}: engine-owned tool`);
  return { unmounted: false, reason };
}
```

The engine sets `alwaysVisible: true` and `preventUnmount: true` on all three
meta-tools in `registerRuntimeMetaTools`.

The refusal is unconditional. The guard logs a warning.

### D6 — A refused unmount is reported truthfully

`unmountTracked` returns `DroneToolUnmountResult` (`{ unmounted, reason? }`).
The type travels the whole unmount surface: `DronePluginRegistration.unmountTool`,
`DroneSlashCommandContext.engine.unmountTool`, `DronePluginEngine.unmountTool`,
the engine and registration implementations, and the CLI engine subset in
`drone-agent/src/interactive.ts`.

- `runtime__unmount_tool` returns `{ success: false, tool, error }` when the
  engine refuses.
- `/tool unmount <name>` logs `Cannot unmount <name>: <reason>` when the engine
  refuses.

The LLM and the human must not believe that a tool was unmounted when the engine
kept it.

## Rejected alternatives

- **A `runtime__` prefix check instead of a flag.** Hard-codes one plugin's
  naming into the visibility filter, and cannot express "the engine owns this"
  for any other engine-owned tool. A declarative flag keeps the engine's intent
  on the tool definition.
- **One combined flag.** Visibility and unmount protection are different
  behaviours with different enforcement points. Combining them would force every
  owner of one behaviour to inherit the other.
- **Make all mounted tools always visible.** Removes the persona `allowedTools`
  filter's purpose for the tools it is meant to gate. Only engine-owned tools
  need the exemption.

## Consequences

- A persona can no longer lose the meta-tools through `allowedTools`
  inclusions. A `!runtime__*` exclusion still removes them deliberately.
- The unmount surface returns a result instead of `void`. Every implementer and
  mock of `unmountTool` must return `DroneToolUnmountResult`.
- `premountedTools` (ADR [109](109-persona-level-tool-premounting.md)) and the
  `defaultHidden` filter behave as before.
- Follow-up insights, not fixed here: `ToolRegistry.mount()` returns `undefined`
  for an already-mounted tool, which `applyToolPremount` reads as "unknown tool";
  `runtime__unmount_tool` returns `success: true` for an unknown tool name; the
  premount union ignores `!` exclusions while the alwaysVisible exemption does
  not.
