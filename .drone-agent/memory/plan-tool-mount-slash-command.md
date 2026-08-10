---
key: plan-tool-mount-slash-command
tags:
  []
created: 2026-08-10T04:54:39.518Z
updated: 2026-08-10T04:54:39.518Z
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

The current handler (lines ~130-160) splits `ctx.line.slice('/tool '.length)` and treats everything as a tool run. Update it to check `ctx.args[0]` for subcommands first:

```typescript
const toolCommand: DroneSlashCommand = {
  command: '/tool',
  description: 'Tool utilities: /tool mount <name>, /tool unmount <name> [--all], or run a tool: /tool <name> [<json-args>]',
  handler: async (ctx: DroneSlashCommandContext) => {
    const sub = ctx.args[0];

    // ── /tool mount <name> ──
    if (sub === 'mount') {
      const name = ctx.args[1];
      if (!name || ctx.args.length > 2) {
        ctx.logger.error('Usage: /tool mount <canonicalName>  e.g. /tool mount file__read');
        return true;
      }
      if (!ctx.engine.mountTool) {
        ctx.logger.error('/tool mount: no mountTool callback available');
        return true;
      }
      const def = ctx.engine.mountTool(name);
      if (!def) {
        ctx.logger.error(`Unknown or already mounted tool: ${name}`);
      } else {
        ctx.logger.info(`Mounted ${name}.`);
      }
      return true;
    }

    // ── /tool unmount ──
    if (sub === 'unmount') {
      if (!ctx.engine.unmountTool || !ctx.engine.listMountedTools) {
        ctx.logger.error('/tool unmount: no unmount callback available');
        return true;
      }
      if (ctx.args[1] === '--all') {
        const mounted = ctx.engine.listMountedTools();
        const targets = mounted.filter(t => !t.name.startsWith('runtime__'));
        if (targets.length === 0) {
          ctx.logger.info('No mounted tools to unmount.');
          return true;
        }
        for (const t of targets) ctx.engine.unmountTool(t.name);
        ctx.logger.info(`Unmounted ${targets.length} tool(s): ${targets.map(t => t.name).join(', ')}`);
        return true;
      }
      const name = ctx.args[1];
      if (!name || ctx.args.length > 2) {
        ctx.logger.error('Usage: /tool unmount <canonicalName>  or  /tool unmount --all');
        return true;
      }
      ctx.engine.unmountTool(name);
      ctx.logger.info(`Unmounted ${name}.`);
      return true;
    }

    // ── existing run-a-tool behavior ──
    const rest = ctx.line.slice('/tool '.length).trim();
    // ... unchanged existing logic ...
  },
};
```

Keep `tryParseJson` and the existing tool-run logic unchanged.

### 5. `drone-agent/test/builtin-commands.test.ts` — add tests

Add a `describe('/tool mount/unmount built-in command')` block following the existing patterns (find the command via `BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/tool')`, use `makeTestLogger`, build a `DroneSlashCommandContext` with `mountTool`/`unmountTool`/`listMountedTools` backed by a real `ToolRegistry` from `drone-core` or a simple local `Map`).

Test cases:
1. `/tool mount file__read` mounts a tool (assert via the backing registry, and that logger got `Mounted file__read.`)
2. `/tool mount unknown__tool` logs an error (mount returns undefined)
3. `/tool unmount file__read` unmounts a single tool
4. `/tool unmount --all` unmounts all non-`runtime__` tools but leaves `runtime__*` mounted
5. Existing direct-run behavior still works (e.g. `/tool someTool {}`) — ensure no regression

The existing `/debug` test block constructs the context with only `executeTool`/`runHooks`/`getCapability` — those still typecheck because the new engine fields are all **optional** (`mountTool?` etc.). Verify existing tests still pass.

## Validation criteria

1. **LSP passes** — no type errors in the 5 modified files (plugin-system.ts, plugin-engine.ts, interactive.ts, builtin-commands.ts, builtin-commands.test.ts).
2. **`pnpm -r run build` passes** — all packages compile (drone-core type change recompiles into both packages).
3. **`pnpm -r run lint` passes** — eslint + prettier.
4. **`pnpm -r run test` passes** — all existing tests (incl. `builtin-commands.test.ts`, `macros.test.ts`, TUI tests) still pass, plus the new `/tool mount|unmount` tests.
5. **Manual verification:**
   - `/tool mount file__read` → `Mounted file__read.` → subsequent `/tools` shows `file__read` available
   - `/tool mount bogus__tool` → error `Unknown or already mounted tool: bogus__tool`
   - `/tool unmount file__read` → `Unmounted file__read.`
   - `/tool unmount --all` → unmounts all non-`runtime__` tools, leaves `runtime__list_tools`/`runtime__mount_tool`/`runtime__unmount_tool` mounted
   - `/tool /someTool {}`-style direct-run still works (no regression)
   - Works identically in both CLI (interactive.ts) and TUI (via full engine pass-through)

## Notes / caveats

- Persona switches still wipe manual mounts (persona plugin owns the mounted-tool surface via `applyToolPremount`). This is expected and consistent with the existing design; no change needed.
- `docs/agents/mcp-plugin.md` is stale (references removed `ToolMountingCache`) but is out of scope for this feature.
