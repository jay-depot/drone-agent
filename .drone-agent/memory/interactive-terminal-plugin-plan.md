---
key: interactive-terminal-plugin-plan
tags:
  - plan
  - terminal-plugin
  - feature
created: 2026-07-02T02:42:37.649Z
updated: 2026-07-02T02:42:37.649Z
---

# Interactive Terminal Plugin Plan

## Summary
Add a new `terminal` plugin that gives LLM agents PTY-based interactive terminal sessions for TUI testing, driving tmux, and interactive programs. Separate plugin (not merged into exec). Uses `node-pty`. Opt-in (`defaultEnabled: false`). Tools are `defaultHidden: true`.

## Files to create/modify

### drone-core/src/config-types.ts
- Add `DroneTerminalConfig` type (enabled, maxActiveSessions, defaultShell, defaultCols, defaultRows)
- Add to `DroneAgentConfig` and `PartialDroneAgentConfig`
- Add to `createDefaultAgentConfig()` defaults
- Add merge stanza in `applyAgentConfigLayer()`

### drone-core/src/config-schema.ts
- Add `terminal` section to `PartialDroneAgentConfigSchema`

### drone-core/src/index.ts
- Export `DroneTerminalConfig` type

### drone-agent/package.json
- Add `node-pty` dependency

### drone-agent/src/plugins/terminal/constants.ts
- MAX_READ_BUFFER_BYTES = 64KB
- MAX_SCREENSHOT_BUFFER_BYTES = 256KB
- DEFAULT_COLS/ROWS

### drone-agent/src/plugins/terminal/key-codec.ts
- `encodeKeys(input: string): Buffer` — hybrid encoder
- Named sequences: <Enter>, <Ctrl-C>, <Ctrl-D>, <Ctrl-Z>, <Escape>/<Esc>, <Tab>, <Alt-x>, <Backspace>, <Delete>, <Up>, <Down>, <Left>, <Right>, <PageUp>, <PageDown>, <Home>, <End>, <F1>-<F12>
- << → literal <
- Unknown named sequences pass through as raw text

### drone-agent/src/plugins/terminal/session-manager.ts
- `TerminalSession` type: id, pty (IPty), command, cwd, createdAt, cols, rows, screenBuffer, pendingOutput
- `TerminalSessionManager` class with maxSessions cap
- Methods: create, write, read, screenshot, resize, list, kill, killAll
- read() returns and drains pendingOutput (scrollback since last capture)
- screenshot() returns full screenBuffer (what a human would see)
- onData handler accumulates both buffers
- Cap all buffers at MAX limits

### drone-agent/src/plugins/terminal/plugin.ts
- metadata: id='terminal', defaultEnabled=false
- Prompt fragment listing active sessions (returns false when empty)
- 7 tools, all defaultHidden=true:
  1. terminal__create — start session (command defaults to $SHELL)
  2. terminal__write — send keystrokes (hybrid encoding)
  3. terminal__read — read+drain new output since last read
  4. terminal__screenshot — full accumulated screen buffer
  5. terminal__resize — resize PTY dimensions
  6. terminal__list — list active sessions
  7. terminal__kill — kill a session
- onPluginsLoaded: init manager from config
- onShutdown: killAll()

### drone-agent/src/plugins/terminal/index.ts
- barrel export of terminalPlugin

### drone-agent/src/plugins/index.ts
- Add terminalPlugin to staticBuiltInPlugins array

### drone-agent/test/terminal.test.ts
- Key encoding unit tests
- Session manager tests (with mock or real PTY)
- Plugin registration test

## Dependencies
1. Step 1 (drone-core types) must be done before Step 2-4
2. Step 2 (node-pty install) must be done before Step 3c (uses node-pty)
3. Step 3a-d can be done in parallel (constants, key-codec, session-manager, plugin.ts)
4. Step 4 (register in index.ts) depends on Step 3d
5. Step 5 (onShutdown) is part of Step 3d
6. Step 6 (tests) depends on Step 3
7. Steps 7-8 (build/lint) depend on everything else

## Validation
- pnpm typecheck passes
- pnpm lint passes
- pnpm test passes (all existing + new)
- LSP diagnostics clean
- All DroneTerminalConfig types exported
- Terminal tools appear in /tools
- Prompt fragment hides when no sessions active
- Capacity limit returns error (not crash)
- Unknown sessionId returns error (not throw)
- onShutdown kills all sessions
- Hybrid key encoding works correctly