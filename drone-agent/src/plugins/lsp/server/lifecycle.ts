import { type ChildProcess } from 'node:child_process';

export const CRASH_GUARD_FAILURE_LIMIT = 3;
export const CRASH_GUARD_WINDOW_MS = 60_000;
export const KILL_GRACE_MS = 2000;

/**
 * Per-spec sliding-window crash guard. A spec that accumulates
 * `failureLimit` failures inside `windowMs` is blocked from starting
 * again until enough failures age out of the window, preventing a
 * crash loop of instant respawn cycles.
 */
export class CrashGuard {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly failureLimit: number = CRASH_GUARD_FAILURE_LIMIT,
    private readonly windowMs: number = CRASH_GUARD_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  record(specId: string): void {
    const timestamp = this.now();
    const window = (this.failures.get(specId) ?? []).filter(
      entry => timestamp - entry < this.windowMs
    );
    window.push(timestamp);
    this.failures.set(specId, window);
  }

  isBlocked(specId: string): boolean {
    const timestamp = this.now();
    const window = (this.failures.get(specId) ?? []).filter(
      entry => timestamp - entry < this.windowMs
    );
    this.failures.set(specId, window);
    return window.length >= this.failureLimit;
  }

  reset(specId: string): void {
    this.failures.delete(specId);
  }
}

/**
 * Per-key in-flight promise dedup. Concurrent `run` calls with the same
 * key share one promise; the entry is cleared when the promise settles
 * (success or failure), so a failed start can be retried immediately.
 */
export function createInFlightDedup<K>(): {
  run: <T>(key: K, fn: () => Promise<T>) => Promise<T>;
  has: (key: K) => boolean;
} {
  const inFlight = new Map<K, Promise<unknown>>();

  return {
    run: <T>(key: K, fn: () => Promise<T>): Promise<T> => {
      const existing = inFlight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }
      const promise = fn().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
    has: key => inFlight.has(key),
  };
}

/**
 * Kill a spawned LSP server child: send SIGTERM, then race the child's
 * 'close' event against a grace timer. A child that ignores SIGTERM is
 * escalated to SIGKILL so shutdown can never leave a lingering process.
 * Resolves once the child has closed (bounded by the grace window); a
 * child that already exited resolves immediately.
 */
export function killWithEscalation(
  child: ChildProcess,
  graceMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once('close', () => {
      clearTimeout(timer);
      finish();
    });
    child.kill();
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
      }
    }, graceMs);
  });
}
