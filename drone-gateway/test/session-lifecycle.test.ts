import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionLifecycle,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '../src/surfaces/lifecycle.js';
import type { SpawnBackend } from '../src/spawn-backend.js';
import type { SurfaceContext } from '../src/surfaces/types.js';
import type { SpawnSession } from '../src/types.js';

function makeSession(id: string): SpawnSession {
  return {
    conversationId: 'conv-1',
    personaId: 'coder',
    processId: id,
    startedAt: Date.now(),
  };
}

function makeBackend(overrides: Partial<SpawnBackend> = {}): SpawnBackend {
  let counter = 0;
  const backend: SpawnBackend = {
    type: 'local' as const,
    spawnSession: vi.fn(async () => makeSession(`agent-${++counter}`)),
    sendMessage: vi.fn(async () => 'reply'),
    terminateSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return backend;
}

function makeCtx(
  backend: SpawnBackend,
  overrides: Partial<SurfaceContext> = {}
): SurfaceContext {
  return { spawnBackend: backend, swarm: undefined, ...overrides };
}

describe('SessionLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns once and reuses the session across turns', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await lifecycle.send('hi');
    await lifecycle.send('again');

    expect(backend.spawnSession).toHaveBeenCalledTimes(1);
    expect(backend.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('forwards targetBeaconId and workingDir from the context', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend, {
        targetBeaconId: 'beacon-9',
        workingDir: '/srv/bots',
      }),
    });

    await lifecycle.send('hi');

    expect(backend.spawnSession).toHaveBeenCalledWith('conv-1', 'coder', {
      targetBeaconId: 'beacon-9',
      workingDir: '/srv/bots',
    });
  });

  it('forwards send options to the backend and returns a null reply as-is', async () => {
    const sendMessage = vi.fn(async () => null as string | null);
    const backend = makeBackend({ sendMessage });
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await expect(
      lifecycle.send('hi', { systemReminder: 'ROOM' })
    ).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), 'hi', {
      systemReminder: 'ROOM',
    });
  });

  it('treats a null reply as normal: no re-spawn, idle timer still arms', async () => {
    const backend = makeBackend({
      sendMessage: vi.fn(async () => null as string | null),
    });
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend, { idleTimeoutMs: 1000 }),
    });

    await expect(lifecycle.send('hi')).resolves.toBeNull();
    expect(backend.spawnSession).toHaveBeenCalledTimes(1);
    expect(backend.terminateSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1001);
    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });

  it('terminates after the default idle timeout and re-spawns on the next message', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await lifecycle.send('hi');
    expect(backend.terminateSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS + 1);
    expect(backend.terminateSession).toHaveBeenCalledTimes(1);

    await lifecycle.send('back');
    expect(backend.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('resets the idle timer after each successful turn', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend, { idleTimeoutMs: 1000 }),
    });

    await lifecycle.send('hi');
    await vi.advanceTimersByTimeAsync(900);
    await lifecycle.send('again');
    // 900ms past the reset timer: the first turn's timer must not have fired.
    await vi.advanceTimersByTimeAsync(200);
    expect(backend.terminateSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });

  it('never fires the timer when idleTimeoutMs is 0', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend, { idleTimeoutMs: 0 }),
    });

    await lifecycle.send('hi');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(backend.terminateSession).not.toHaveBeenCalled();
  });

  it('re-spawns and retries once when sendMessage throws', async () => {
    let call = 0;
    const backend = makeBackend({
      sendMessage: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('agent gone');
        return 'recovered';
      }),
    });
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await expect(lifecycle.send('hi')).resolves.toBe('recovered');
    expect(backend.spawnSession).toHaveBeenCalledTimes(2);
    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });

  it('propagates the error when the retry also fails', async () => {
    const backend = makeBackend({
      sendMessage: vi.fn(async () => {
        throw new Error('still gone');
      }),
    });
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await expect(lifecycle.send('hi')).rejects.toThrow('still gone');
  });

  it('dispose terminates the session and is idempotent', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await lifecycle.send('hi');
    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });

  it('rejects send after dispose', async () => {
    const backend = makeBackend();
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    await lifecycle.dispose();
    await expect(lifecycle.send('hi')).rejects.toThrow('surface disposed');
    expect(backend.spawnSession).not.toHaveBeenCalled();
  });

  it('serializes concurrent sends so they never overlap', async () => {
    const order: string[] = [];
    const backend = makeBackend({
      sendMessage: vi.fn(async (_s, text: string) => {
        order.push(`start:${text}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(`end:${text}`);
        return text;
      }),
    });
    const lifecycle = new SessionLifecycle({
      surfaceType: 'persona-assignment',
      conversationId: 'conv-1',
      personaId: 'coder',
      ctx: makeCtx(backend),
    });

    const p1 = lifecycle.send('a');
    const p2 = lifecycle.send('b');
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});
