import { spawn, type ChildProcess } from 'node:child_process';
import {
  createInterface as createLineInterface,
  type Interface,
} from 'node:readline';
import { logger } from './logger.js';
import { resolveDroneExecutable } from 'drone-core';
import type { DronePortableContextExport } from 'drone-core';
import type { SendMessageOptions, SpawnBackend } from './spawn-backend.js';
import type { SpawnSession, SpawnSessionOptions } from './types.js';

/** Max stderr lines retained per child for early-exit diagnostics. */
const MAX_STDERR_LINES = 20;

/** Max stderr lines included in an early-exit error string. */
const STDERR_TAIL_LINES = 10;

/** Grace period before a SIGTERM'd agent is escalated to SIGKILL. */
const TERMINATE_GRACE_MS = 5000;

/**
 * LocalSpawnBackend spawns `drone-agent` processes on the host.
 *
 * Each conversation gets a persistent agent process that communicates
 * via NDJSON over stdin/stdout. The agent runs with `--output-json`
 * (without `--once`), entering the JSON listen mode that reads `chat`
 * events from stdin and emits NDJSON events (including `turnComplete`)
 * to stdout.
 */
export class LocalSpawnBackend implements SpawnBackend {
  readonly type = 'local' as const;

  private agentPath: string;
  private sessions: Map<string, ManagedAgentSession> = new Map();
  private pending: Map<string, Promise<SpawnSession>> = new Map();

  constructor(agentPath?: string) {
    this.agentPath = agentPath || 'drone-agent';
  }

  async spawnSession(
    conversationId: string,
    personaId: string,
    opts?: SpawnSessionOptions
  ): Promise<SpawnSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      return existing.session;
    }

    // Concurrent callers for one conversation share a single in-flight spawn
    // so no two child processes are created for the same session.
    const inFlight = this.pending.get(conversationId);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.startSession(conversationId, personaId, opts);
    this.pending.set(conversationId, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(conversationId);
    }
  }

  private async startSession(
    conversationId: string,
    personaId: string,
    opts: SpawnSessionOptions | undefined
  ): Promise<SpawnSession> {
    const resolvedPath = await resolveDroneExecutable({
      commandName: this.agentPath,
    });
    logger.info(
      `Spawning agent for conversation ${conversationId} using ${resolvedPath}`
    );

    const workingDir = opts?.workingDir;
    const args: string[] = ['--output-json'];

    if (personaId) {
      args.push('--persona', personaId);
    }

    if (workingDir) {
      args.push('--working-dir', workingDir);
    }

    if (opts?.extensionHint) {
      args.push('--extension-hint', opts.extensionHint);
    }

    const childProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      ...(workingDir ? { cwd: workingDir } : {}),
    });

    const session: SpawnSession = {
      conversationId,
      personaId,
      processId: `pid-${childProcess.pid}`,
      startedAt: Date.now(),
      workingDir,
    };

    const managed: ManagedAgentSession = {
      session,
      process: childProcess,
      stderrTail: [],
      reader: createLineInterface({ input: childProcess.stdout! }),
      pending: null,
    };

    this.sessions.set(conversationId, managed);

    managed.reader.on('line', line => this.handleLine(managed, line));
    managed.reader.on('close', () => this.failPending(managed));

    // Drain the child's stderr so agent logs are visible in the gateway log
    // (and so the pipe cannot fill and stall the child). The last lines are
    // retained for an early-exit diagnostic.
    if (childProcess.stderr) {
      const stderrRl = createLineInterface({ input: childProcess.stderr });
      stderrRl.on('line', line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        logger.info({ conversationId }, `[agent] ${trimmed}`);
        managed.stderrTail.push(trimmed);
        if (managed.stderrTail.length > MAX_STDERR_LINES) {
          managed.stderrTail.shift();
        }
      });
    }

    // Handle process exit
    childProcess.on('exit', (code, signal) => {
      logger.info(
        `Agent for conversation ${conversationId} exited: code=${code}, signal=${signal}`
      );
      this.failPending(managed);
      this.sessions.delete(conversationId);
    });

    childProcess.on('error', err => {
      logger.error(
        `Agent for conversation ${conversationId} error: ${err.message}`
      );
      this.failPending(managed);
      this.sessions.delete(conversationId);
    });

    return session;
  }

  /**
   * Route one NDJSON stdout line to the single in-flight request, if its kind
   * matches. A response for a different kind is ignored (there can be at most
   * one request because `request` rejects a second concurrent call).
   */
  private handleLine(managed: ManagedAgentSession, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: { kind: string; [k: string]: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      logger.warn(`Failed to parse NDJSON line: ${trimmed}`);
      return;
    }

    switch (event.kind) {
      case 'assistantMessage':
        if (managed.pending) {
          managed.pending.lastAssistantMessage = String(event.content ?? '');
        }
        break;
      case 'turnComplete':
        this.settle(managed, 'chat', p => p.resolve(p.lastAssistantMessage));
        break;
      case 'contextExport':
        if (event.ok) {
          this.settle(managed, 'export', p => p.resolve(event.context));
        } else {
          this.settle(managed, 'export', p =>
            p.reject(new Error(String(event.error)))
          );
        }
        break;
      case 'contextImport':
        if (event.ok) {
          this.settle(managed, 'import', p => p.resolve(undefined));
        } else {
          this.settle(managed, 'import', p =>
            p.reject(new Error(String(event.error)))
          );
        }
        break;
      case 'error':
        logger.error(`Agent error: ${String(event.message)}`);
        break;
      default:
        break;
    }
  }

  private settle(
    managed: ManagedAgentSession,
    kind: PendingRequest['kind'],
    act: (pending: PendingRequest) => void
  ): void {
    const pending = managed.pending;
    if (!pending || pending.kind !== kind) return;
    managed.pending = null;
    act(pending);
  }

  /**
   * Reject the single in-flight request (if any) with the preserved early-exit
   * error string carrying the last stderr lines.
   */
  private failPending(managed: ManagedAgentSession): void {
    const pending = managed.pending;
    if (!pending) return;
    managed.pending = null;
    pending.reject(this.earlyExitError(managed));
  }

  private earlyExitError(managed: ManagedAgentSession): Error {
    const tail = managed.stderrTail
      .slice(-STDERR_TAIL_LINES)
      .join('\n')
      .trim()
      .slice(-800);
    return new Error(`agent exited before replying${tail ? `: ${tail}` : ''}`);
  }

  private request<T>(
    managed: ManagedAgentSession,
    kind: PendingRequest['kind'],
    write: () => void
  ): Promise<T> {
    if (managed.pending) {
      return Promise.reject(
        new Error('An agent request is already in flight for this conversation')
      );
    }
    return new Promise<T>((resolve, reject) => {
      managed.pending = {
        kind,
        lastAssistantMessage: '',
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      write();
    });
  }

  async sendMessage(
    session: SpawnSession,
    message: string,
    opts?: SendMessageOptions
  ): Promise<string | null> {
    const managed = this.requireSession(session);
    if (!managed.process.stdin) {
      throw new Error('Agent process has no stdin');
    }
    const chatEvent =
      JSON.stringify({
        type: 'chat',
        message,
        ...(opts?.systemReminder
          ? { systemReminder: opts.systemReminder }
          : {}),
      }) + '\n';
    return this.request<string>(managed, 'chat', () =>
      managed.process.stdin!.write(chatEvent)
    );
  }

  async exportContext(
    session: SpawnSession
  ): Promise<DronePortableContextExport> {
    const managed = this.requireSession(session);
    if (!managed.process.stdin) {
      throw new Error('Agent process has no stdin');
    }
    return this.request<DronePortableContextExport>(managed, 'export', () =>
      managed.process.stdin!.write(
        JSON.stringify({ type: 'exportContext' }) + '\n'
      )
    );
  }

  async importContext(
    session: SpawnSession,
    data: DronePortableContextExport
  ): Promise<void> {
    const managed = this.requireSession(session);
    if (!managed.process.stdin) {
      throw new Error('Agent process has no stdin');
    }
    return this.request<void>(managed, 'import', () =>
      managed.process.stdin!.write(
        JSON.stringify({ type: 'importContext', context: data }) + '\n'
      )
    );
  }

  async terminateSession(session: SpawnSession): Promise<void> {
    const managed = this.sessions.get(session.conversationId);
    if (!managed) {
      logger.warn(
        `No active session to terminate for conversation ${session.conversationId}`
      );
      return;
    }

    logger.info(`Terminating agent for conversation ${session.conversationId}`);
    this.failPending(managed);
    managed.reader.close();

    const child = managed.process;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyExited) {
      const graceTimer = setTimeout(() => {
        // A child that exited during the grace window must not be SIGKILLed.
        if (child.exitCode === null && child.signalCode === null) {
          logger.warn(
            `Agent for conversation ${session.conversationId} did not exit gracefully, sending SIGKILL`
          );
          child.kill('SIGKILL');
        }
      }, TERMINATE_GRACE_MS);
      graceTimer.unref();
      child.once('exit', () => clearTimeout(graceTimer));
      child.kill('SIGTERM');
    }

    this.sessions.delete(session.conversationId);
  }

  private requireSession(session: SpawnSession): ManagedAgentSession {
    const managed = this.sessions.get(session.conversationId);
    if (!managed) {
      throw new Error(
        `No active session for conversation ${session.conversationId}`
      );
    }
    return managed;
  }
}

interface PendingRequest {
  kind: 'chat' | 'export' | 'import';
  lastAssistantMessage: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface ManagedAgentSession {
  session: SpawnSession;
  process: ChildProcess;
  /** Ring buffer of the child's most recent stderr lines (newest last). */
  stderrTail: string[];
  /** Single persistent stdout reader; one reader per session (D15). */
  reader: Interface;
  /** The single in-flight request slot (callers serialize per conversation). */
  pending: PendingRequest | null;
}
