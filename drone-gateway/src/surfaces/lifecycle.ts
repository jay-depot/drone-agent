import { logger } from '../logger.js';
import type { SpawnSession } from '../types.js';
import type { SurfaceContext } from './types.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface SessionLifecycleOptions {
  surfaceType: string;
  conversationId: string;
  personaId: string;
  ctx: SurfaceContext;
}

/**
 * Owns a surface's single agent session: spawn-on-demand, idle-timeout
 * termination, one-shot death recovery, and shutdown disposal. All work is
 * serialized on an internal tail so a surface instance shared by several
 * conversations (e.g. the wildcard) can never overlap two turns.
 */
export class SessionLifecycle {
  private session: SpawnSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: SessionLifecycleOptions) {
    this.idleTimeoutMs = opts.ctx.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async ensureSession(): Promise<SpawnSession> {
    if (this.session) return this.session;
    const session = await this.opts.ctx.spawnBackend.spawnSession(
      this.opts.conversationId,
      this.opts.personaId,
      {
        targetBeaconId: this.opts.ctx.targetBeaconId,
        workingDir: this.opts.ctx.workingDir,
      }
    );
    this.session = session;
    return session;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      void this.expireIdle();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private async expireIdle(): Promise<void> {
    this.idleTimer = null;
    const session = this.session;
    if (!session || this.disposed) return;
    this.session = null;
    logger.info(
      { conversationId: this.opts.conversationId },
      `Idle timeout: terminating ${this.opts.surfaceType} agent`
    );
    try {
      await this.opts.ctx.spawnBackend.terminateSession(session);
    } catch (err) {
      logger.warn({ err }, 'Idle-timeout terminate failed');
    }
  }

  async send(text: string): Promise<string> {
    return this.run(async () => {
      if (this.disposed) throw new Error('surface disposed');
      const session = await this.ensureSession();
      try {
        const response = await this.opts.ctx.spawnBackend.sendMessage(
          session,
          text
        );
        this.armIdleTimer();
        return response;
      } catch (err) {
        logger.warn(
          { err, conversationId: this.opts.conversationId },
          'sendMessage failed; re-spawning agent and retrying once'
        );
        try {
          await this.opts.ctx.spawnBackend.terminateSession(session);
        } catch {
          // best effort
        }
        if (this.session === session) this.session = null;
        const fresh = await this.ensureSession();
        const response = await this.opts.ctx.spawnBackend.sendMessage(
          fresh,
          text
        );
        this.armIdleTimer();
        return response;
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      await this.opts.ctx.spawnBackend.terminateSession(session);
    } catch (err) {
      logger.warn({ err }, 'Dispose terminate failed');
    }
  }
}
