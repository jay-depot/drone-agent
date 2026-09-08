import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  CrashGuard,
  createInFlightDedup,
  killWithEscalation,
  CRASH_GUARD_FAILURE_LIMIT,
  CRASH_GUARD_WINDOW_MS,
} from '../src/plugins/lsp/server/lifecycle.js';
import { startFakeLspServer } from './lsp-fake-server.js';

function makeFakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: ms => {
      current += ms;
    },
  };
}

describe('CrashGuard', () => {
  it('is not blocked below the failure limit', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    guard.record('spec');
    guard.record('spec');
    expect(guard.isBlocked('spec')).toBe(false);
  });

  it('blocks at the failure limit inside the window', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    for (let i = 0; i < CRASH_GUARD_FAILURE_LIMIT; i++) {
      guard.record('spec');
    }
    expect(guard.isBlocked('spec')).toBe(true);
  });

  it('unblocks as failures age out of the sliding window', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    guard.record('spec');
    clock.advance(10);
    guard.record('spec');
    clock.advance(10);
    guard.record('spec');
    expect(guard.isBlocked('spec')).toBe(true);
    // Age out the two oldest failures; the newest stays inside the window.
    clock.advance(CRASH_GUARD_WINDOW_MS - 10);
    expect(guard.isBlocked('spec')).toBe(false);
  });

  it('counts only failures inside the window', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    guard.record('spec');
    clock.advance(CRASH_GUARD_WINDOW_MS + 1);
    guard.record('spec');
    guard.record('spec');
    expect(guard.isBlocked('spec')).toBe(false);
  });

  it('tracks specs independently', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    for (let i = 0; i < CRASH_GUARD_FAILURE_LIMIT; i++) {
      guard.record('a');
    }
    expect(guard.isBlocked('a')).toBe(true);
    expect(guard.isBlocked('b')).toBe(false);
  });

  it('reset clears a spec block', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    for (let i = 0; i < CRASH_GUARD_FAILURE_LIMIT; i++) {
      guard.record('spec');
    }
    expect(guard.isBlocked('spec')).toBe(true);
    guard.reset('spec');
    expect(guard.isBlocked('spec')).toBe(false);
  });

  it('isBlocked prunes stale entries so old failures do not accumulate', () => {
    const clock = makeFakeClock();
    const guard = new CrashGuard(
      CRASH_GUARD_FAILURE_LIMIT,
      CRASH_GUARD_WINDOW_MS,
      clock.now
    );
    for (let i = 0; i < CRASH_GUARD_FAILURE_LIMIT; i++) {
      guard.record('spec');
      clock.advance(10);
    }
    clock.advance(CRASH_GUARD_WINDOW_MS);
    // All failures are stale now; new failures start from zero.
    guard.record('spec');
    guard.record('spec');
    expect(guard.isBlocked('spec')).toBe(false);
  });
});

describe('createInFlightDedup', () => {
  it('shares one promise for concurrent callers with the same key', async () => {
    const dedup = createInFlightDedup<string>();
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return 42;
    };

    const [a, b, c] = await Promise.all([
      dedup.run('k', fn),
      dedup.run('k', fn),
      dedup.run('k', fn),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
  });

  it('does not dedup across different keys', async () => {
    const dedup = createInFlightDedup<string>();
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    await Promise.all([dedup.run('a', fn), dedup.run('b', fn)]);
    expect(calls).toBe(2);
  });

  it('clears the entry on failure so the next call retries', async () => {
    const dedup = createInFlightDedup<string>();
    let attempts = 0;
    const failing = async (): Promise<number> => {
      attempts += 1;
      throw new Error(`attempt ${attempts} failed`);
    };

    await expect(dedup.run('k', failing)).rejects.toThrow('attempt 1 failed');
    await expect(dedup.run('k', failing)).rejects.toThrow('attempt 2 failed');
    expect(attempts).toBe(2);
  });

  it('parallel callers all receive the same failure', async () => {
    const dedup = createInFlightDedup<string>();
    let attempts = 0;
    const failing = async (): Promise<number> => {
      attempts += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('shared failure');
    };

    const results = await Promise.allSettled([
      dedup.run('k', failing),
      dedup.run('k', failing),
    ]);
    expect(attempts).toBe(1);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
  });

  it('clears the entry after success so a later call re-runs', async () => {
    const dedup = createInFlightDedup<string>();
    let calls = 0;
    const run = () =>
      dedup.run('k', async () => {
        calls += 1;
        return calls;
      });
    await run();
    const second = await run();
    expect(second).toBe(2);
  });

  it('has() reflects in-flight state', async () => {
    const dedup = createInFlightDedup<string>();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const promise = dedup.run('k', () => gate);
    expect(dedup.has('k')).toBe(true);
    release?.();
    await promise;
    expect(dedup.has('k')).toBe(false);
  });
});

describe('killWithEscalation', () => {
  it('resolves when the child exits on the initial kill', async () => {
    const fake = await startFakeLspServer({ respondToInitialize: true });
    try {
      await fake.waitForReady();
      await killWithEscalation(fake.child, 2000);
      expect(
        fake.child.exitCode !== null || fake.child.signalCode !== null
      ).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // A node process with a SIGTERM ignore handler.
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: 'pipe' }
    );
    await new Promise(resolve => setTimeout(resolve, 150));
    const start = Date.now();
    await killWithEscalation(child as ChildProcess, 150);
    const elapsed = Date.now() - start;
    expect(child.signalCode).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it('resolves immediately for an already-exited child', async () => {
    const fake = await startFakeLspServer({ respondToInitialize: true });
    try {
      await fake.waitForReady();
      fake.child.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 50));
      await killWithEscalation(fake.child, 2000);
      expect(fake.child.signalCode).toBe('SIGKILL');
    } finally {
      await fake.stop();
    }
  });

  it('does not throw when the child has already exited with code 0', async () => {
    const fake = await startFakeLspServer({});
    try {
      await fake.waitForReady();
      fake.child.stdin.end();
      await new Promise(resolve => setTimeout(resolve, 50));
      await expect(killWithEscalation(fake.child, 2000)).resolves.toBe(
        undefined
      );
    } finally {
      await fake.stop();
    }
  });
});

describe('spy-based shutdown race sanity', () => {
  it('dedup entry is free while a start is still settling (shutdown race shape)', async () => {
    const dedup = createInFlightDedup<string>();
    const errors: Error[] = [];
    const fn = async (): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('start aborted');
    };
    const p1 = dedup.run('spec', fn).catch(error => {
      errors.push(error as Error);
    });
    // A shutdown racing the start must not join the failing promise; it
    // runs its own teardown logic instead.
    const p2 = dedup.run('other', async () => 'teardown');
    await Promise.all([p1, p2]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('start aborted');
  });
});
