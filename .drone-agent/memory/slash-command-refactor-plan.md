---
key: slash-command-refactor-plan
tags:
  - planning
  - slash-commands
  - refactor
  - plugin-system
created: 2026-06-28T18:18:30.905Z
updated: 2026-06-28T18:18:30.905Z
---

# Slash Command Refactor Plan

## Summary

Refactor built-in slash commands (`/exit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`) from being hardcoded in the TUI (`app.tsx`) and CLI (`interactive.ts`) to being registered through the engine's slash command system. This unifies built-in and plugin commands into a single registry with a precedence model: built-ins have lower precedence than plugin commands, allowing plugins to override them. Additionally, unrecognized slash commands should display an error instead of being sent to the LLM.

## Motivation

- **Philosophy:** Everything should be replaceable by plugins, including core commands like `/exit` and `/clear`.
- **Consistency:** Currently built-ins bypass the engine entirely, meaning two code paths handle slash commands (host-level + engine-level). This is fragile and confusing.
- **Error handling:** Unrecognized slash commands silently become LLM prompts in the TUI, which is surprising behavior.
- **Discoverability:** A unified registry makes `/help` output and command listing consistent.

---

## Architecture

### Unified Slash Command Registry

The engine will have two internal registries:

```
builtInSlashCommands: DroneSlashCommand[]    // Lower precedence
pluginSlashCommands: Map<string, DroneSlashCommand[]>  // Higher precedence (by plugin ID)
```

Dispatch order: **Plugin commands first, then built-in commands.** If a plugin registers `/help`, it overrides the built-in `/help`. If no plugin handles it, the built-in runs.

### Extended Context

`DroneSlashCommandContext` (in `drone-core/src/plugin-system.ts`) gets new optional fields:

```typescript
export type DroneSlashCommandContext = {
  // ... existing fields ...
  conversation?: {
    getModel: () => string;
    setModel: (model: string) => void;
    sendUserMessage: (...) => Promise<string>;
    clearSession?: () => void;       // NEW — for /clear
  };
  /** NEW — Request the host to exit. Implementations should call this to shut down. */
  exit?: () => void;
};
```

These are optional so minimal hosts don't need to provide them. Built-in command handlers will gracefully handle their absence (e.g., `/exit` with no `exit` function logs an error, `/clear` without `clearSession` logs an error).

### Engine API Changes

The engine type (`DronePluginEngine`) gets two new methods:

```typescript
// Register a built-in slash command (lower precedence than plugin commands)
registerBuiltinSlashCommand: (command: DroneSlashCommand) => void;

// Get all built-in slash commands (for help listings)
getBuiltinSlashCommands: () => DroneSlashCommand[];
```

The existing `dispatchSlashCommand` method is updated to check plugin commands first, then fall through to built-in commands.

The existing `getSlashCommands` method (which returns plugin commands only) is kept. A new `getAllSlashCommands` method can be added for help/ listing purposes, or `getSlashCommands` is updated to return both.

### Registration Flow

1. Engine is created (`createDronePluginEngine`)
2. Built-in slash commands are registered via `registerBuiltinSlashCommand()` — this happens during engine initialization, before plugins load
3. Plugins load and register their commands via `registerSlashCommand()` (the plugin registration API — unchanged)
4. On dispatch, plugin commands are checked first, then built-ins

### Override Notification

During `onSessionStart` (or after plugin loading), the engine logs a startup notice for any built-in command that has been overridden by a plugin:

```
⚠ Built-in command /help overridden by plugin "my-plugin"
```

This is informational, not an error.

---

## Behavior Changes

### 1. Unrecognized Slash Commands → Error

**Current (TUI):** Unrecognized `/foo` is sent to the LLM as a chat message.
**Current (CLI):** Unrecognized `/foo` shows "Unknown command: /foo. Try /help."

**New (both):** Unrecognized slash commands display an error:
```
Unknown command: /foo. Type /help for available commands.
```

This applies only to lines starting with `/`. Regular chat messages (not starting with `/`) are unaffected.

### 2. Drop `?` Alias

The `?` alias for `/help` is removed. Only `/help` is recognized.

---

## Implementation Steps

### Step 1: Update `DroneSlashCommandContext` in drone-core

**File:** `drone-core/src/plugin-system.ts`

- Add `exit?: () => void` to `DroneSlashCommandContext`
- Add `clearSession?: () => void` to the `conversation` object in `DroneSlashCommandContext`

```typescript
export type DroneSlashCommandContext = {
  line: string;
  args: string[];
  logger: DroneLogger;
  engine: { ... };
  conversation?: {
    getModel: () => string;
    setModel: (model: string) => void;
    sendUserMessage: (...) => Promise<string>;
    clearSession?: () => void;    // NEW
  };
  sessionManager?: { ... };
  exit?: () => void;               // NEW
};
```

### Step 2: Add built-in slash command registry to plugin engine

**File:** `drone-agent/src/runtime/plugin-engine.ts`

- Add `builtInSlashCommands: DroneSlashCommand[]` storage (in addition to existing `slashCommands` Map)
- Add `registerBuiltinSlashCommand(command: DroneSlashCommand): void` method to the engine
- Add `getBuiltinSlashCommands(): DroneSlashCommand[]` method
- Update `dispatchSlashCommand` to check plugin commands first (existing behavior), then fall through to built-in commands (new)
- Update `getSlashCommands` to return both plugin and built-in commands (for help/listing purposes), OR add `getAllSlashCommands` — prefer updating `getSlashCommands` since callers use it for help listings
- Add override detection: after plugins load, check which built-in commands have the same `command` string as a plugin command; log a warning for each

### Step 3: Register built-in slash commands in the engine

**File:** `drone-agent/src/runtime/plugin-engine.ts` (or a new `builtin-commands.ts` module imported by the engine)

Register these built-in commands via `registerBuiltinSlashCommand()`:

| Command | Handler Behavior |
|---------|-----------------|
| `/exit`, `/quit` | Call `ctx.exit?.()` |
| `/help` | Call `ctx.engine.getHelpSnippets()` + `ctx.engine.getSlashCommands()` and format output via `ctx.logger.info()` |
| `/clear` | Call `ctx.conversation?.clearSession?.()` + `ctx.engine.runHooks('onSessionClear')` |
| `/plugins` | Call `ctx.engine.listPlugins()` and format via `ctx.logger.info()` |
| `/tools` | Call `ctx.engine.listTools()` and format via `ctx.logger.info()` |
| `/systemprompt` | Call `ctx.engine.renderPromptFragments()` + `ctx.engine.getConfig()` and format via `ctx.logger.info()` |
| `/tool` | Parse `<name> <JSON>`, call `ctx.engine.executeTool(name, parsed)` |
| `/exec` | Parse `<command>`, call `ctx.engine.executeTool('exec.run', {command, cwd})` |

Each handler returns `true` on success, `false` if prerequisites are missing (e.g., `exit` not available).

**Note:** `/help` output will include keybinding info. Since the host owns `printHelp`, the `/help` handler will check for a host-provided help function via a capability (e.g., `ctx.engine.getCapability('tui.help')`) or a context field. If not available (CLI mode), it falls back to a minimal format. **Alternative (simpler):** The host passes a `printHelp` callback through the context, and the built-in `/help` handler calls it.

**Decision:** Add an optional `printHelp?: () => void` to the context. The host sets this when constructing the dispatch context. The `/help` built-in calls it if present; otherwise falls back to listing commands via `ctx.logger.info()`.

### Step 4: Update `DroneSlashCommandContext` to include `printHelp`

**File:** `drone-core/src/plugin-system.ts`

```typescript
export type DroneSlashCommandContext = {
  // ... existing fields ...
  /** NEW — Host-provided help display function (TUI passes its printHelp, CLI passes its own). */
  printHelp?: () => void;
};
```

### Step 5: Update TUI to use unified dispatch

**File:** `drone-agent/src/tui/app.tsx`

- Remove all hardcoded built-in slash command checks (`/exit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`)
- The `runSlashCommand` callback becomes much simpler:
  ```typescript
  async function runSlashCommand(line: string) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    log(`> ${trimmed}`, 'user');

    if (trimmed.startsWith('/')) {
      // Dispatch through engine (checks plugin commands, then built-ins)
      const handled = await opts.engine.dispatchSlashCommand(trimmed, {
        logger: { info: msg => log(msg, 'user'), warn: msg => log(msg, 'error'), error: msg => log(msg, 'error') },
        engine: opts.engine,
        conversation: opts.conversation,
        sessionManager: undefined,
        exit: () => exit(),
        printHelp: () => printHelp(opts, log),
      });
      if (!handled) {
        log(`Unknown command: ${trimmed}. Type /help for available commands.`, 'error');
      }
      return;
    }

    // Regular chat message
    setIsLlmActive(true);
    // ... existing chat message flow ...
  }
  ```

- Remove the `?` alias check
- Update `printHelp` to dynamically list all slash commands from `engine.getSlashCommands()` (which now returns both built-in and plugin commands)
- Remove the `setIsLlmActive(true)` / `finally { setIsLlmActive(false) }` wrapping around `dispatchSlashCommand` — only wrap the actual LLM chat message call

### Step 6: Update CLI to use unified dispatch

**File:** `drone-agent/src/interactive.ts`

- Remove all hardcoded built-in slash command checks (`/exit`, `/quit`, `/clear`, `/help`, `/tools`)
- Simplify the slash command handling:
  ```typescript
  if (line.startsWith('/')) {
    const handled = await engine.dispatchSlashCommand(line, {
      logger,
      engine: { ... },
      conversation: { ... },
      sessionManager: { ... },
      exit: () => { /* set a flag to break the loop */ },
      printHelp: () => { /* print help via logger */ },
    });
    if (!handled) {
      logger.warn(`Unknown command: ${line}. Type /help for available commands.`);
    }
    continue;
  }
  ```

- For `/exit` in CLI mode, the `exit` callback needs to break the `while(true)` loop. Use a flag:
  ```typescript
  let shouldExit = false;
  // ... in exit callback: shouldExit = true;
  if (shouldExit) break;
  ```

### Step 7: Update `printHelp` in TUI to use dynamic command list

**File:** `drone-agent/src/tui/app.tsx`

The `printHelp` function currently hardcodes command descriptions. Update it to:
1. Keep the hardcoded keybinding section (host-specific)
2. Pull all slash commands via `engine.getSlashCommands()` (which now includes built-ins)
3. Format them dynamically:
  ```typescript
  const commands = opts.engine.getSlashCommands();
  helpLines.push('', 'Slash commands:', '');
  for (const cmd of commands) {
    helpLines.push(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
  }
  ```

### Step 8: Update CLI help to use dynamic command list

**File:** `drone-agent/src/interactive.ts`

The CLI `/help` handler currently calls `engine.getHelpSnippets()`. Update it to also list all slash commands from `engine.getSlashCommands()`.

### Step 9: Update test mocks

**Files:**
- `drone-agent/test/helpers.ts` — Add `registerBuiltinSlashCommand`, `getBuiltinSlashCommands` to the mock engine
- `drone-agent/test/tui.test.tsx` — Update mocks to include new context fields
- `drone-agent/test/systemprompt.test.tsx` — Update mocks
- `drone-agent/test/tui-persona-color.test.tsx` — Update mocks
- `drone-agent/test/persona-tool-call-limit.test.ts` — Update mocks
- `drone-agent/test/conversation-service.test.ts` — Update mocks

Each mock that currently has `dispatchSlashCommand: async () => false` needs:
- `registerBuiltinSlashCommand: () => {}` (no-op)
- `getBuiltinSlashCommands: () => []`
- Any new context fields as needed

### Step 10: Add tests for new behavior

**New test file:** `drone-agent/test/slash-command-refactor.test.ts` (or add to existing)

Tests:
1. **Built-in dispatch:** `/exit`, `/help`, `/clear`, `/tools`, `/plugins` are handled by the engine
2. **Plugin override:** A plugin registers `/help` → plugin handler runs, built-in does not
3. **Override notification:** When a plugin overrides a built-in, a warning is logged
4. **Unknown command error:** `/foo` (unrecognized) returns `false` from dispatch and the host shows an error
5. **`?` alias removed:** `?` is no longer recognized as `/help`
6. **Missing context fields:** `/exit` without `exit` callback logs an error but doesn't crash

---

## Files to Modify

| File | Changes |
|------|---------|
| `drone-core/src/plugin-system.ts` | Add `exit?`, `clearSession?`, `printHelp?` to `DroneSlashCommandContext` |
| `drone-agent/src/runtime/plugin-engine.ts` | Add `builtInSlashCommands` storage, `registerBuiltinSlashCommand`, `getBuiltinSlashCommands`, update `dispatchSlashCommand`, update `getSlashCommands`, add override detection |
| `drone-agent/src/tui/app.tsx` | Remove hardcoded built-ins, simplify `runSlashCommand`, update `printHelp` to use dynamic command list, remove `?` alias |
| `drone-agent/src/interactive.ts` | Remove hardcoded built-ins, simplify slash command handling, update help output |
| `drone-agent/test/helpers.ts` | Update mock engine with new methods |
| `drone-agent/test/tui.test.tsx` | Update mocks |
| `drone-agent/test/systemprompt.test.tsx` | Update mocks |
| `drone-agent/test/tui-persona-color.test.tsx` | Update mocks |
| `drone-agent/test/persona-tool-call-limit.test.ts` | Update mocks |
| `drone-agent/test/conversation-service.test.ts` | Update mocks |

**New file (optional):**
| `drone-agent/src/runtime/builtin-commands.ts` | Built-in command definitions (keeps engine file clean) |

---

## Validation Criteria

1. **All LSP checks pass** (`pnpm typecheck`)
2. **All tests pass** (`pnpm test`)
3. **Linting passes** (`pnpm lint`)
4. **Build succeeds** (`pnpm build`)
5. **Manual verification:**
   - `/exit`, `/help`, `/clear`, `/tools`, `/plugins`, `/systemprompt`, `/tool`, `/exec` all still work in the TUI
   - `/exit`, `/help`, `/clear`, `/tools` all still work in CLI mode
   - `/foo` (unrecognized) shows an error instead of being sent to the LLM
   - `?` no longer triggers help
   - A plugin registering `/help` overrides the built-in
   - Override notification appears in startup messages
   - `/help` output lists both built-in and plugin commands dynamically