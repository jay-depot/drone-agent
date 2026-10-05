import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPersonaAssignmentSurface } from '../src/surfaces/persona-assignment.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../src/surfaces/lifecycle.js';
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
  return {
    type: 'local' as const,
    spawnSession: vi.fn(async () => makeSession(`agent-${++counter}`)),
    sendMessage: vi.fn(async () => 'hello back'),
    terminateSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeSurface(
  backend: SpawnBackend,
  ctxOverrides: Partial<SurfaceContext> = {},
  specOverrides: Record<string, unknown> = {}
) {
  const ctx: SurfaceContext = {
    spawnBackend: backend,
    swarm: undefined,
    ...ctxOverrides,
  };
  return createPersonaAssignmentSurface(
    { type: 'persona-assignment', personaId: 'coder', ...specOverrides },
    'conv-1',
    ctx
  );
}

function msg(text: string) {
  return { adapterId: 'a', conversationId: 'conv-1', text };
}

describe('createPersonaAssignmentSurface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when personaId is missing', () => {
    expect(() =>
      createPersonaAssignmentSurface({ type: 'persona-assignment' }, 'conv-1', {
        spawnBackend: {} as never,
        swarm: undefined,
      })
    ).toThrow('persona-assignment control surface requires personaId');
  });

  it('has a per-conversation id and type', () => {
    const surface = makeSurface(makeBackend());
    expect(surface.id).toBe('persona-assignment-conv-1');
    expect(surface.type).toBe('persona-assignment');
  });

  it('spawns on the first message then sends it', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    const result = await surface.handleMessage(msg('hi'));

    expect(result).toEqual({ response: 'hello back', handled: true });
    expect(backend.spawnSession).toHaveBeenCalledTimes(1);
    expect(backend.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reuses the session for a second message', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('one'));
    await surface.handleMessage(msg('two'));

    expect(backend.spawnSession).toHaveBeenCalledTimes(1);
    expect(backend.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('forwards targetBeaconId and workingDir from the context', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend, {
      targetBeaconId: 'beacon-9',
      workingDir: '/srv/bots/coder',
    });

    await surface.handleMessage(msg('hi'));

    expect(backend.spawnSession).toHaveBeenCalledWith('conv-1', 'coder', {
      targetBeaconId: 'beacon-9',
      workingDir: '/srv/bots/coder',
    });
  });

  it('terminates the agent after the idle timeout', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('hi'));
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS + 1);

    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });

  it('re-spawns and retries when the agent has died', async () => {
    let call = 0;
    const backend = makeBackend({
      sendMessage: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('agent gone');
        return 'recovered';
      }),
    });
    const surface = makeSurface(backend);

    const result = await surface.handleMessage(msg('hi'));

    expect(result).toEqual({ response: 'recovered', handled: true });
    expect(backend.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('reports failures as an Error: response', async () => {
    const backend = makeBackend({
      spawnSession: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const surface = makeSurface(backend);

    const result = await surface.handleMessage(msg('hi'));

    expect(result).toEqual({ response: 'Error: boom', handled: true });
  });

  it('dispose terminates a live session', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('hi'));
    await surface.dispose?.();

    expect(backend.terminateSession).toHaveBeenCalledTimes(1);
  });
});
