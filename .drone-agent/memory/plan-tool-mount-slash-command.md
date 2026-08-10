---
key: plan-tool-mount-slash-command
tags:
  []
created: 2026-08-10T04:54:39.518Z
updated: 2026-08-10T05:01:30.341Z
---

# Plan: `/tool mount` / `/tool unmount` slash commands

## Summary

Let the user mount/unmount tools themselves via the existing `/tool` slash command, for when they know the next request will need a tool that isn't currently mounted. Currently mounting can only be done by the LLM via the `runtime__mount_tool` meta-tool, or implicitly by persona premount. This gives the human an explicit way to prepare the tool surface ahead of a request.

## Design decisions (confirmed with user)

- **Organized under `/tool`** as subcommands — not new top-level commands.
- **Extend the shared context type** (`DroneSlashCommandContext.engine` + the full `DronePluginEngine`) with direct `mountTool`/`unmountTool`/`listMountedTools` methods (the type-safe route), rather than round-tripping through `runtime__mount_tool` via `executeTool`.
- **No `/tool mounted`** — redundant with `/tools`.
- **`/tool unmount --all`** mirrors persona `applyToolPremount()` semantics: unmount all currently-mounted non-`runtime__` tools.

## Command surface

- `/tool mount <canonicalName>` — mount a tool (e.g. `/tool mount file__read`)
- `/tool unmount <canonicalName>` — unmount a single mounted tool
- `/tool unmount --all` — unmount all mounted non-`runtime__` tools
- anything else → existing "run a tool directly" behavior (`/tool <name> [<json-args>]`)

## Data flow

```
/tool mount file__read
  → builtin-commands.ts toolCommand handler
    → ctx.engine.mountTool('file__read')
      → engine return object mountTool → toolRegistry.mount('file__read')
        → mounted tool appears in conversation service getLlmTools() (engine.listTools())
```

## Files to modify

### 1. `drone-agent/src/runtime/plugin-engine.ts`

**a) Add three methods to the `DronePluginEngine` type** (near `listTools`/`listAllTools`, ~line 93-95):

```typescript
mountTool: (canonicalName: string) => DroneToolDefinition | undefined;
unmountTool: (canonicalName: string) => void;
listMountedTools: () => DroneToolDescriptor[];
```

**b) Implement them in the return object** (near `listTools`, ~line 833):

```typescript
mountTool: canonicalName => toolRegistry.mount(canonicalName),
unmountTool: canonicalName => toolRegistry.unmount(canonicalName),
listMountedTools: () => toolRegistry.listMounted(),
```

`DroneToolDefinition` is already imported in the file (used in `getTool`). `DroneToolDescriptor` is already imported.

### 2. `drone-core/src/plugin-system.ts` — add to `DroneSlashCommandContext.engine` subset

Add near `listTools`/`listAllTools` (after line ~308):

```typescript
/** Mount a tool by canonical name (for /tool mount). */
mountTool?: (canonicalName: string) => import('./session-types.js').DroneToolDefinition | undefined;
/** Unmount a mounted tool by canonical name (for /tool unmount). */
unmountTool?: (canonicalName: string) => void;
/** List currently-mounted tools (for /tool unmount --all). */
listMountedTools?: () => import('./session-types.js').DroneToolDescriptor[];
```

Note: `DroneToolDefinition` is not referenced in plugin-system.ts yet — use the inline `import('./session-types.js').DroneToolDefinition` form to match the file's existing style for cross-file types.

### 3. `drone-agent/src/interactive.ts` — wire the CLI engine subset

In the `engine: { ... }` passed to `dispatchSlashCommand` (~line 365), add:

```typescript
mountTool: name => engine.mountTool(name),
unmountTool: name => engine.unmountTool(name),
listMountedTools: () => engine.listMountedTools(),
```

The TUI (`tui/app.tsx`) passes `engine: opts.engine` (the full `DronePluginEngine`), so it needs **no change**.

### 4. `drone-agent/src/runtime/builtin-commands.ts` — extend `/tool` handler

The current handler (lines ~130-160) splits `ctx.line.slice('/tool '.length)` and treats everything as a tool run. Update it to check `ctx.args[0]` for subcommands first.

### 5. `drone-agent/test/builtin-commands.test.ts` — add tests

Add a `describe('/tool mount/unmount built-in command')` block following the existing patterns (find the command via `BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/tool')`, use `makeTestLogger`, build a `DroneSlashCommandContext` with `mountTool`/`unmountTool`/`listMountedTools` backed by a real `ToolRegistry` from `drone-core`).

Test cases:
1. `/tool mount file__read` mounts a tool
2. `/tool mount unknown__tool` logs an error (mount returns undefined)
3. `/tool unmount file__read` unmounts a single tool
4. `/tool unmount --all` unmounts all non-`runtime__` tools but leaves `runtime__*` mounted
5. Existing direct-run behavior still works (no regression)

The existing `/debug` test block constructs the context with only `executeTool`/`runHooks`/`getCapability` — those still typecheck because the new engine fields are all **optional** (`mountTool?` etc.).

## Validation criteria

1. **LSP passes** — no type errors in the 5 modified files.
2. **`pnpm -r run build` passes** — all packages compile (drone-core type change recompiles into both packages).
3. **`pnpm -r run lint` passes** — eslint + prettier.
4. **`pnpm -r run test` passes** — all existing tests still pass, plus the new `/tool mount|unmount` tests.
5. **Manual verification** as described in the command surface above.

## Notes / caveats

- Persona switches still wipe manual mounts (persona plugin owns the mounted-tool surface via `applyToolPremount`). This is expected and consistent with the existing design; no change needed.
- `docs/agents/mcp-plugin.md` is stale (references removed `ToolMountingCache`) but is out of scope for this feature.

---

## EXECUTION COMPLETE (2026-08-10)

Implemented and committed as `241348d`. All validation passed:
- LSP clean on all modified files
- `pnpm -r run build` passes
- `pnpm -r run typecheck` passes (incl. test tsconfig — the only `useSgrMouse.test.tsx` errors are pre-existing)
- `pnpm test` passes: 1770 passed / 112 files. (`useTailRegion.test.tsx` failed on one run but is a pre-existing flaky timing test — passes in isolation and on rerun.)
- Prettier applied to `builtin-commands.test.ts` and `plugin-system.ts`.

Files changed: `drone-agent/src/runtime/plugin-engine.ts`, `drone-core/src/plugin-system.ts`, `drone-agent/src/interactive.ts`, `drone-agent/src/runtime/builtin-commands.ts`, `drone-agent/test/builtin-commands.test.ts`, `drone-agent/test/helpers.ts`.

Notable execution findings (deviations from plan as written):
1. **`DroneToolDefinition` is defined in `plugin-system.ts` itself** (not in `session-types.ts`), so the inline `import('./session-types.js').DroneToolDefinition` form in the plan was wrong — the actual fix uses the local `DroneToolDefinition` type directly (no import needed).
2. **`test/helpers.ts` mock engines** needed the three new required methods added to `createFakeEngine` and `createMockEngine` (the plan's "5 modified files" omitted this 6th file).
3. **LSP resolves `drone-core` from its built `dist/`**, so the build must run before LSP/typecheck reflects drone-core type changes; after editing drone-core you must rebuild to clear stale LSP errors.
4. The plan's test for "unknown tool error" initially failed because `makeTestLogger`'s `error` callback was a no-op — had to capture `error` into `messages` too, and the direct-run test needed `executeTool` to route through the `ToolRegistry` (return the tool's actual result) rather than a hardcoded `'ok'` stub.
