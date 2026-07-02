import type { DronePlugin } from 'drone-core';
import type { DroneToolJsonSchema } from 'drone-core';
import { TerminalSessionManager } from './session-manager.js';
import { encodeKeys } from './key-codec.js';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}

function ensureSessionId(
  input: Record<string, unknown>
): string {
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string.');
  }
  return input.sessionId.trim();
}

// ── Tool input schemas ────────────────────────────────────────────────────

const NO_INPUT_SCHEMA: DroneToolJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const CREATE_INPUT_SCHEMA: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'Command to run. Defaults to $SHELL (auto-detected shell) if omitted.',
    },
    cwd: {
      type: 'string',
      description:
        'Working directory. Defaults to the project root if omitted.',
    },
    cols: {
      type: 'number',
      description:
        'Terminal columns (width). Defaults to 80.',
    },
    rows: {
      type: 'number',
      description:
        'Terminal rows (height). Defaults to 24.',
    },
  },
  additionalProperties: false,
};

const SESSION_ID_REQUIRED_SCHEMA: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description: 'The terminal session ID.',
    },
  },
  required: ['sessionId'],
  additionalProperties: false,
};

const WRITE_INPUT_SCHEMA: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description: 'The terminal session ID.',
    },
    input: {
      type: 'string',
      description:
        'Keystrokes to send. Supports raw text and named sequences: ' +
        '<Enter>, <Ctrl-C>, <Escape>/<Esc>, <Tab>, <Backspace>, ' +
        '<Up>/<Down>/<Left>/<Right>, <Delete>, <Home>, <End>, ' +
        '<PageUp>/<PageDown>, <F1>-<F12>, <Alt-X> (any letter). ' +
        'Use << for a literal <. Does NOT add a trailing newline automatically.',
    },
  },
  required: ['sessionId', 'input'],
  additionalProperties: false,
};

const RESIZE_INPUT_SCHEMA: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description: 'The terminal session ID.',
    },
    cols: {
      type: 'number',
      description: 'New column count (width).',
    },
    rows: {
      type: 'number',
      description: 'New row count (height).',
    },
  },
  required: ['sessionId', 'cols', 'rows'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const terminalPlugin: DronePlugin = {
  metadata: {
    id: 'terminal',
    name: 'Terminal',
    version: '0.1.0',
    description:
      'Interactive PTY terminal sessions for TUI testing, driving tmux, and interactive programs.',
    defaultEnabled: false,
  },

  register: async registration => {
    const config = registration.getConfig().terminal;
    const manager = new TerminalSessionManager(config.maxActiveSessions);

    // ── Prompt fragment: active sessions ──────────────────────────────
    registration.registerPromptFragment({
      key: 'terminal-active-sessions',
      phase: 'header',
      render: async () => {
        const sessions = manager.list();
        if (sessions.length === 0) return false;

        const lines: string[] = ['# Active Terminal Sessions', ''];
        for (const s of sessions) {
          lines.push(
            `- Session \`${s.id}\`: \`${s.command}\` (${s.cols}x${s.rows}) @ ${s.cwd} [pending: ${s.pendingBytes}B, screen: ${s.screenBytes}B]`
          );
        }
        lines.push('');
        lines.push(
          'Use `terminal__*` tools to interact with these sessions. ' +
            'Create new sessions with `terminal__create`, send keystrokes with `terminal__write`, ' +
            'read incremental output with `terminal__read`, capture the full screen with `terminal__screenshot`, ' +
            'resize with `terminal__resize`, list with `terminal__list`, and kill with `terminal__kill`.'
        );
        return lines.join('\n');
      },
    });

    // ── terminal__create ──────────────────────────────────────────────
    registration.registerTool({
      name: 'create',
      description:
        'Start a new interactive terminal session. The session runs a shell (or a specified command) ' +
        'in a pseudo-terminal. Returns the session ID for subsequent interactions. ' +
        'Use terminal__write to send keystrokes, terminal__read to get output since last read, ' +
        'and terminal__screenshot to get the full screen buffer.',
      defaultHidden: true,
      inputSchema: CREATE_INPUT_SCHEMA,
      execute: async input => {
        try {
          if (manager.isFull) {
            return JSON.stringify({
              error: `Maximum terminal sessions reached (${manager.capacity}). Kill an active session first.`,
              activeSessions: manager.count,
              maxSessions: manager.capacity,
            });
          }

          const command =
            typeof input.command === 'string' ? input.command : '';
          const cwd = typeof input.cwd === 'string' ? input.cwd : '';
          const cols = safeParseInt(input.cols, DEFAULT_TERMINAL_COLS);
          const rows = safeParseInt(input.rows, DEFAULT_TERMINAL_ROWS);

          const sessionId = manager.create(command, cwd, cols, rows);

          return JSON.stringify({
            sessionId,
            command: command || '(auto-detected shell)',
            cwd: cwd || '(project root)',
            cols,
            rows,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── terminal__write ───────────────────────────────────────────────
    registration.registerTool({
      name: 'write',
      description:
        'Send keystrokes to an active terminal session. Supports raw text and named sequences: ' +
        '<Enter>, <Ctrl-C>, <Escape>/<Esc>, <Tab>, <Backspace>, <Up>/<Down>/<Left>/<Right>, ' +
        '<Delete>, <Home>, <End>, <PageUp>/<PageDown>, <F1>-<F12>, <Alt-X> (any letter). ' +
        'Use << for a literal <. Does NOT add a trailing newline.',
      defaultHidden: true,
      inputSchema: WRITE_INPUT_SCHEMA,
      execute: async input => {
        try {
          const sessionId = ensureSessionId(input);
          const rawInput =
            typeof input.input === 'string' ? input.input : '';

          if (rawInput.length === 0) {
            return JSON.stringify({
              sessionId,
              charsWritten: 0,
              error: 'No input provided.',
            });
          }

          const data = encodeKeys(rawInput);
          manager.write(sessionId, data);

          return JSON.stringify({
            sessionId,
            charsWritten: data.length,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── terminal__read ────────────────────────────────────────────────
    registration.registerTool({
      name: 'read',
      description:
        'Read and drain new output from a terminal session since the last read(). ' +
        'This is the "scrollback since last capture" tool: each call returns only the output ' +
        'that has accumulated since the previous call and clears the buffer. ' +
        'Use this to poll for incremental output (e.g., wait for a prompt to appear). ' +
        'Returns up to ~64 KB of text. Use terminal__screenshot for the full screen history.',
      defaultHidden: true,
      inputSchema: SESSION_ID_REQUIRED_SCHEMA,
      execute: async input => {
        try {
          const sessionId = ensureSessionId(input);
          const output = manager.read(sessionId);
          return JSON.stringify({
            sessionId,
            output,
            bytes: output.length,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── terminal__screenshot ──────────────────────────────────────────
    registration.registerTool({
      name: 'screenshot',
      description:
        'Capture the full accumulated output of a terminal session. ' +
        'This is the "what a human would see" tool: it returns ALL output produced since ' +
        'the session started (capped at ~256 KB). Unlike terminal__read, this does NOT ' +
        'drain the buffer. Use this to see the complete terminal state.',
      defaultHidden: true,
      inputSchema: SESSION_ID_REQUIRED_SCHEMA,
      execute: async input => {
        try {
          const sessionId = ensureSessionId(input);
          const output = manager.screenshot(sessionId);
          return JSON.stringify({
            sessionId,
            output,
            bytes: output.length,
            truncated: output.length >= 256 * 1024,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── terminal__resize ──────────────────────────────────────────────
    registration.registerTool({
      name: 'resize',
      description:
        'Resize a terminal session PTY dimensions. Useful for TUI testing where programs ' +
        'render differently at different sizes. Does not affect the terminal window size — ' +
        'only the logical dimensions seen by the program running inside the PTY.',
      defaultHidden: true,
      inputSchema: RESIZE_INPUT_SCHEMA,
      execute: async input => {
        try {
          const sessionId = ensureSessionId(input);
          const cols = safeParseInt(input.cols, 80);
          const rows = safeParseInt(input.rows, 24);
          manager.resize(sessionId, cols, rows);
          return JSON.stringify({
            sessionId,
            cols,
            rows,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── terminal__list ────────────────────────────────────────────────
    registration.registerTool({
      name: 'list',
      description:
        'List all active terminal sessions with their metadata (command, cwd, dimensions, buffer sizes).',
      defaultHidden: true,
      inputSchema: NO_INPUT_SCHEMA,
      execute: async () => {
        const sessions = manager.list();
        return JSON.stringify({
          sessions,
          count: sessions.length,
          maxSessions: manager.capacity,
        });
      },
    });

    // ── terminal__kill ────────────────────────────────────────────────
    registration.registerTool({
      name: 'kill',
      description:
        'Kill and remove a terminal session. Releases the PTY resources. ' +
        'Use terminal__list to find session IDs.',
      defaultHidden: true,
      inputSchema: SESSION_ID_REQUIRED_SCHEMA,
      execute: async input => {
        try {
          const sessionId = ensureSessionId(input);
          const killed = manager.kill(sessionId);
          if (!killed) {
            return JSON.stringify({
              error: `Terminal session "${sessionId}" not found or already exited.`,
              sessionId,
            });
          }
          return JSON.stringify({
            sessionId,
            killed: true,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ── Lifecycle hooks ──────────────────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info(
        `terminal plugin ready (max ${manager.capacity} sessions)`
      );
    });

    registration.hooks.onShutdown(async () => {
      manager.killAll();
      registration.logger.info('terminal: killed all active sessions');
    });
  },
};