---
tags: [decision, slash-command, tools, list-mount, feature]
related: [decisions/105-runtime-level-list-mount.md, decisions/109-persona-level-tool-premounting.md, decisions/110-debug-tools-flag.md, modules/drone-agent.md, modules/drone-core.md, architecture/plugin-system.md]
---

# ADR 111: `/tool mount` / `/tool unmount` Slash Commands

**Status**: Implemented (commit `241348d`, 2026-08-10)

## Context

Under the runtime-level list-mount pattern ([105-runtime-level-list-mount](105-runtime-level-list-mount.md)), all tools start unmounted. Only the LLM can discover and mount them via the `runtime__*` meta-tools. When a human user knew the next request would need a specific tool (e.g. `file__read`), there was **no way for the human to pre-mount it themselves** — they'd have to phrase the request to make the LLM mount the tool first, wasting a round-trip and cluttering the tool surface.

The `mountTool`/`unmountTool`/`listMountedTools` primitives existed only on the per-plugin `DronePluginRegistration` (used by the persona plugin's premount, see [109-persona-level-tool-premounting](109-persona-level-tool-premounting.md)). The slash-command engine subset (`DroneSlashCommandContext.engine`) did **not** expose them, so a slash command handler had no direct, type-safe way to mount/unmount.

## Decision

Extend the existing built-in `/tool` slash command with `mount`/`unmount` subcommands (rather than adding new top-level commands), and expose `mountTool`/`unmountTool`/`listMountedTools` on the slash-command engine context.

### Command surface

- `/tool mount <canonicalName>` — mount a tool (e.g. `/tool mount file__read`)
- `/tool unmount <canonicalName>` — unmount a single mounted tool
- `/tool unmount --all` — unmount all currently-mounted **non-`runtime__*`** tools (mirrors the persona plugin's `applyToolPremount()` semantics)
- anything else → existing "run a tool directly" behavior (`/tool <name> [<json-args>]`)

A `/tool mounted` listing subcommand was considered but rejected as redundant — `/tools` already surfaces the mounted set (filtered through the persona).

### Type additions

Three methods were added to **both** the full `DronePluginEngine` (in `drone-agent/src/runtime/plugin-engine.ts`) and the `DroneSlashCommandContext.engine` subset (in `drone-core/src/plugin-system.ts`, as **optional** fields):

```typescript
mountTool?: (canonicalName: string) => DroneToolDefinition | undefined;
unmountTool?: (canonicalName: string) => void;
listMountedTools?: () => DroneToolDescriptor[];
```

The engine return object implements them by delegating to the `ToolRegistry` (`toolRegistry.mount`/`unmount`/`listMounted`).

### Wiring

- `drone-agent/src/interactive.ts` — the CLI engine subset passed to `dispatchSlashCommand` wires the three methods through to the full engine. The **TUI needs no change** — `tui/app.tsx` passes the full engine directly (`engine: opts.engine`).
- The new engine methods are **required** on the full `DronePluginEngine` type, so the two mock engines in `test/helpers.ts` (`createFakeEngine` and `createMockEngine`) gained stub implementations.

### Choice: direct engine methods over `executeTool`

The handler calls `ctx.engine.mountTool(...)` directly rather than round-tripping through `ctx.engine.executeTool('runtime__mount_tool', ...)`. The direct route is type-safe (no JSON-string result parsing), matches how `/debug` was wired, and is the cleaner architecture.

## Consequences

### Positive

- The human can pre-mount tools ahead of a request (`/tool mount file__read`), avoiding an extra LLM mount round-trip
- `unmount --all` gives a quick way to reset the tool surface to just the `runtime__*` meta-tools
- `mountTool`/`unmountTool`/`listMountedTools` are now first-class engine primitives available to any slash command handler

### Neutral

- Persona switches still wipe manual mounts (the persona plugin owns the mounted-tool surface via `applyToolPremount`) — this is expected and consistent with the existing design
- The `/tool` command's description string grew to document the subcommands

## Tests

`test/builtin-commands.test.ts` gained a `/tool mount/unmount built-in command` describe block (5 tests) backed by a real `ToolRegistry` from drone-core:

- `/tool mount file__read` mounts a tool
- `/tool mount bogus__tool` logs an error (mount returns `undefined`)
- `/tool unmount file__write` unmounts a single tool
- `/tool unmount --all` unmounts all non-`runtime__*` tools, leaving `runtime__*` mounted
- Direct-run behavior still works (no regression)

## Related

- [105-runtime-level-list-mount](105-runtime-level-list-mount.md) — The runtime `ToolRegistry` + `runtime__*` meta-tools this builds on
- [109-persona-level-tool-premounting](109-persona-level-tool-premounting.md) — Where `listMountedTools` originated as a registration primitive; `unmount --all` mirrors `applyToolPremount()`
- [110-debug-tools-flag](110-debug-tools-flag.md) — Tool-surface mutations are now traceable via `--debug tools`
- [drone-agent](../../drone-agent/) — Engine + slash command wiring
- [drone-core](../../drone-core/) — `DroneSlashCommandContext.engine` type additions
