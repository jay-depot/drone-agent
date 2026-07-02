import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import process from 'node:process';
import {
  MAX_READ_BUFFER_BYTES,
  MAX_SCREENSHOT_BUFFER_BYTES,
} from './constants.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents one active PTY terminal session.
 */
export type TerminalSession = {
  /** Unique session identifier (e.g. "term-1"). */
  id: string;
  /** The node-pty instance handle. */
  pty: IPty;
  /** The command that was spawned (or the shell path). */
  command: string;
  /** Working directory the PTY was started in. */
  cwd: string;
  /** Timestamp of creation. */
  createdAt: Date;
  /** Current PTY columns. */
  cols: number;
  /** Current PTY rows. */
  rows: number;
  /**
   * Accumulated output since session start. This is "what a human would see"
   * — the full screen buffer. Consulted by `screenshot()`.
   */
  screenBuffer: string;
  /**
   * Output accumulated since the last `read()` call. Consulted and drained
   * by `read()`.
   */
  pendingOutput: string;
};

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();
  private maxSessions: number;
  private nextId = 1;

  constructor(maxSessions: number) {
    this.maxSessions = maxSessions;
  }

  /** True when the number of active sessions has reached the cap. */
  get isFull(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  /** The current capacity cap. */
  get capacity(): number {
    return this.maxSessions;
  }

  /** Number of active sessions. */
  get count(): number {
    return this.sessions.size;
  }

  /**
   * Resolve the default shell command: $SHELL or /bin/sh.
   */
  static resolveShellCommand(defaultShell: string): string {
    if (defaultShell && defaultShell.trim().length > 0) {
      return defaultShell.trim();
    }
    return process.env.SHELL || '/bin/sh';
  }

  // ── Create ─────────────────────────────────────────────────────────

  /**
   * Create a new PTY session.
   *
   * @param command - The command to run. Empty string or falsy => shell.
   * @param cwd     - Working directory. Empty string => process.cwd().
   * @param cols    - PTY columns (default 80).
   * @param rows    - PTY rows (default 24).
   * @returns The session ID string.
   * @throws Error if at capacity.
   */
  create(command: string, cwd: string, cols: number, rows: number): string {
    if (this.isFull) {
      throw new Error(
        `Maximum terminal sessions reached (${this.maxSessions}). ` +
          'Kill an active session before creating a new one.'
      );
    }

    const resolvedCommand =
      command && command.trim().length > 0
        ? command.trim()
        : TerminalSessionManager.resolveShellCommand('');

    const resolvedCwd =
      cwd && cwd.trim().length > 0 ? cwd.trim() : process.cwd();

    const sessionId = `term-${this.nextId++}`;

    const child = pty.spawn(resolvedCommand, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
    });

    const session: TerminalSession = {
      id: sessionId,
      pty: child,
      command: resolvedCommand,
      cwd: resolvedCwd,
      createdAt: new Date(),
      cols,
      rows,
      screenBuffer: '',
      pendingOutput: '',
    };

    // Wire data listener to accumulate output in both buffers
    child.onData(data => {
      session.pendingOutput += data;
      session.screenBuffer += data;

      // Trim buffers to prevent unbounded growth
      if (session.pendingOutput.length > MAX_READ_BUFFER_BYTES * 2) {
        session.pendingOutput = session.pendingOutput.slice(
          -MAX_READ_BUFFER_BYTES
        );
      }
      if (session.screenBuffer.length > MAX_SCREENSHOT_BUFFER_BYTES * 2) {
        session.screenBuffer = session.screenBuffer.slice(
          -MAX_SCREENSHOT_BUFFER_BYTES
        );
      }
    });

    // Clean up on process exit
    child.onExit(() => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  // ── Write ──────────────────────────────────────────────────────────

  /**
   * Write raw bytes to a PTY session.
   *
   * @param sessionId - The session to write to.
   * @param data      - Buffer or string of raw bytes.
   * @throws Error if the session is not found.
   */
  write(sessionId: string, data: Buffer | string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session "${sessionId}" not found.`);
    }
    session.pty.write(data);
  }

  // ── Read (draining) ────────────────────────────────────────────────

  /**
   * Read and drain pending output since the last `read()` call.
   *
   * This is the "scrollback buffer since last capture" tool — each call
   * returns only the new output that accumulated since the previous read,
   * and then clears that buffer. Use this to poll for incremental output.
   *
   * @param sessionId - The session to read from.
   * @returns The new output string (may be empty).
   * @throws Error if the session is not found.
   */
  read(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session "${sessionId}" not found.`);
    }
    const output = session.pendingOutput;
    session.pendingOutput = '';
    return output;
  }

  // ── Screenshot (full buffer) ───────────────────────────────────────

  /**
   * Return the full accumulated output buffer of a session.
   *
   * This is the "what a human would see" tool — it returns ALL output that
   * has been produced since the session started (capped at ~256 KB). Unlike
   * `read()`, this does NOT drain the buffer.
   *
   * @param sessionId - The session to capture.
   * @returns The full screen buffer (may be truncated at the cap).
   * @throws Error if the session is not found.
   */
  screenshot(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session "${sessionId}" not found.`);
    }
    // Return only the last MAX_SCREENSHOT_BUFFER_BYTES
    if (session.screenBuffer.length > MAX_SCREENSHOT_BUFFER_BYTES) {
      return session.screenBuffer.slice(-MAX_SCREENSHOT_BUFFER_BYTES);
    }
    return session.screenBuffer;
  }

  // ── Resize ─────────────────────────────────────────────────────────

  /**
   * Resize a PTY session.
   *
   * @param sessionId - The session to resize.
   * @param cols      - New columns.
   * @param rows      - New rows.
   * @throws Error if the session is not found.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session "${sessionId}" not found.`);
    }
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  // ── List ───────────────────────────────────────────────────────────

  /**
   * List all active sessions with metadata.
   */
  list(): {
    id: string;
    command: string;
    cwd: string;
    cols: number;
    rows: number;
    createdAt: string;
    pendingBytes: number;
    screenBytes: number;
  }[] {
    const result: {
      id: string;
      command: string;
      cwd: string;
      cols: number;
      rows: number;
      createdAt: string;
      pendingBytes: number;
      screenBytes: number;
    }[] = [];

    for (const session of this.sessions.values()) {
      result.push({
        id: session.id,
        command: session.command,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt.toISOString(),
        pendingBytes: session.pendingOutput.length,
        screenBytes: session.screenBuffer.length,
      });
    }

    return result;
  }

  // ── Kill ───────────────────────────────────────────────────────────

  /**
   * Kill and remove a single session.
   *
   * @param sessionId - The session to kill.
   * @returns true if the session was found and killed, false if it was
   *          already gone (e.g. exited on its own).
   */
  kill(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    try {
      session.pty.kill();
    } catch {
      // Process may already be dead — ignore
    }
    this.sessions.delete(sessionId);
    return true;
  }

  // ── Kill all (shutdown) ────────────────────────────────────────────

  /**
   * Kill all active sessions. Safe to call multiple times.
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      try {
        this.sessions.get(id)?.pty.kill();
      } catch {
        // Already dead — ignore
      }
    }
    this.sessions.clear();
  }
}
