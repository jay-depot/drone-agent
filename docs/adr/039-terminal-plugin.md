---
tags: [decision, plugin]
related: [terminal-plugin.md, plugin-system.md, exec.md]
---

# ADR 039: Interactive Terminal Plugin (Separate from Exec)

**Status**: Accepted (2026-07-01)

## Context

The existing `exec` plugin runs shell commands via `spawn()` with `shell: true` and `stdio: ['ignore', 'pipe', 'pipe']`. It is stateless — spawn, capture stdout/stderr, return JSON. There is no interactivity, no stdin, no PTY.

Agents needed the ability to:

- Test TUIs (tools like `fzf`, `htop`, `nano`)
- Drive `tmux` sessions
- Run interactive programs that require stdin
- Send keystrokes with proper terminal semantics (Ctrl+C, Escape sequences, etc.)

Several approaches were considered.

## Decision

Create a **separate** `terminal` plugin using `node-pty` for genuine PTY support. Key design choices:

### Why a separate plugin (not merged into exec)

- **Different interaction model**: `exec` is stateless (fire, forget, return JSON); PTY sessions are inherently stateful (hold a PTY fd, maintain scrollback buffer, track cursor position, support resize/keystroke injection)
- **Different lifecycle**: `exec` has no `onShutdown` concerns beyond a timeout; terminal sessions must be explicitly killed and cleaned up on shutdown
- **Different dependency profile**: `terminal` requires `node-pty` (native addon), which `exec` does not need
- **Opt-in security**: Terminal sessions are powerful and potentially dangerous — keeping them in a separate opt-in plugin (`defaultEnabled: false`) means users explicitly choose to expose this capability

### Why node-pty

- **Genuine PTY**: `node-pty` creates real pseudo-terminals. Child processes see `isTTY = true`, color detection works, and programs behave as they would in a real terminal
- **Cross-platform**: Works on Linux, macOS, and Windows
- **Mature**: Widely used by VS Code's terminal, xterm.js integrations, and terminal emulators
- **Native performance**: Written in C++ with Node.js bindings, minimal overhead

### Why hybrid key encoding

Rather than requiring the LLM to know raw ASCII codes (e.g., `\x03` for Ctrl+C) or raw escape sequences (e.g., `\x1b[A` for Up arrow), the plugin provides a hybrid encoder:

- **Named sequences** like `<Ctrl-C>`, `<Enter>`, `<Up>`, `<F1>` are LLM-friendly and descriptive
- **Raw text** passes through unchanged for normal typing
- **`<<` escape** provides a way to send literal angle brackets
- **Unknown sequences pass through** as raw text — graceful degradation

This eliminates the need for the LLM to memorize terminal escape codes while still allowing raw byte-level control when needed.

### Read vs Screenshot distinction

Two separate read tools with deliberately different semantics:

- **`terminal__read`**: Drains the pending output buffer. Use for polling — "what happened since I last checked?"
- **`terminal__screenshot`**: Returns the full accumulated buffer. Use for inspection — "what does the terminal look like now?"

This mirrors the distinction in real terminal usage between "scroll back through recent output" and "look at the whole screen."

### Opt-in by design

- `defaultEnabled: false` — the plugin is not loaded unless explicitly enabled
- All 7 tools are `defaultHidden: true` — hidden from the LLM unless a persona explicitly permits them
- Configurable `maxActiveSessions` cap (default: 5) prevents runaway session creation
- Errors are returned as JSON strings, never thrown — the LLM sees descriptive error messages

## Consequences

### Positive

- Agents can now test TUIs, drive tmux, and interact with interactive programs
- `exec` plugin remains lean and unchanged — no regression risk
- The `onShutdown` hook ensures all sessions are killed on exit
- The prompt fragment keeps the LLM informed of active sessions
- 48 tests cover key encoding, session management, and plugin registration

### Negative

- `node-pty` is a native addon that requires compilation (C++ toolchain, Python for node-gyp)
- Must approve native builds in pnpm (via `pnpm approve-builds`)
- Each active session consumes system resources (PTY fd, process, memory for buffers)
- The 48 tests are the minimum — real TUI testing with actual interactive programs would benefit from more integration tests

### Future Considerations

- **Integration testing**: The current tests use `/bin/sh` with `echo` commands. Future work could add tests that verify TUI behavior (e.g., launching `tmux` and verifying pane splits)
- **Multi-output capture**: The current `read()`/`screenshot()` model works well for text output but may struggle with heavy escape-sequence-filled output. A future enhancement could strip ANSI escape codes for cleaner output
- **Session persistence**: Sessions currently die on agent shutdown. Reconnecting to sessions started outside the agent (e.g., attaching to an existing tmux session) is not supported
- **Output streaming**: For long-running commands, the LLM must actively poll via `terminal__read`. A push-based model (e.g., `terminal__wait_for_string`) could be added later

## Related

- terminal-plugin — Concept page with implementation details
- [plugin-system](002-plugin-system.md) — Plugin architecture
- [drone-agent-plugins](../../drone-agent/src/plugins/) — All built-in plugins
