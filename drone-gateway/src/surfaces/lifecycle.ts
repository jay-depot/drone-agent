import { logger } from '../logger.js';
import type { SpawnSession } from '../types.js';
import type { SurfaceContext } from './types.js';
import type { SendMessageOptions } from '../spawn-backend.js';

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
        extensionHint: `${this.opts.ctx.extensionHintPrefix}:${this.opts.conversationId}`,
      }
    );
    this.session = session;

    const store = this.opts.ctx.snapshotStore;
    if (store) {
      const snapshot = store.getSnapshot(this.opts.conversationId);
      if (snapshot) {
        try {
          await this.opts.ctx.spawnBackend.importContext(session, snapshot);
        } catch (err) {
          logger.warn(
            { err, conversationId: this.opts.conversationId },
            'Context restore failed; starting with a fresh context'
          );
        }
      }
    }
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

  async send(text: string, opts?: SendMessageOptions): Promise<string | null> {
    return this.run(async () => {
      if (this.disposed) throw new Error('surface disposed');
      const session = await this.ensureSession();
      try {
        const response = await this.opts.ctx.spawnBackend.sendMessage(
          session,
          text,
          opts
        );
        this.armIdleTimer();
        await this.snapshot();
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
          text,
          opts
        );
        this.armIdleTimer();
        await this.snapshot();
        return response;
      }
    });
  }

  /**
   * Export the live context and persist it for this conversation. Runs inside
   * the lifecycle tail, so exactly one backend request is ever in flight (D15).
   * A snapshot failure is non-fatal: the turn already succeeded.
   */
  private async snapshot(): Promise<void> {
    const store = this.opts.ctx.snapshotStore;
    const session = this.session;
    if (!store || !session) return;
    try {
      const context = await this.opts.ctx.spawnBackend.exportContext(session);
      const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
      store.saveSnapshot(this.opts.conversationId, context);
      logger.debug(
        { conversationId: this.opts.conversationId, bytes },
        'Saved context snapshot'
      );
    } catch (err) {
      logger.warn(
        { err, conversationId: this.opts.conversationId },
        'Context snapshot failed'
      );
    }
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
