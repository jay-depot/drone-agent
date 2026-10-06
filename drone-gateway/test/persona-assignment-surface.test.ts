import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPersonaAssignmentSurface } from '../src/surfaces/persona-assignment.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../src/surfaces/lifecycle.js';
import { NO_RESPONSE_SENTINEL, ROOM_INSTRUCTION } from '../src/chat-format.js';
import type { SpawnBackend, SendMessageOptions } from '../src/spawn-backend.js';
import type { SurfaceContext } from '../src/surfaces/types.js';
import type { AdapterMessage, SpawnSession } from '../src/types.js';

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

function msg(
  text: string,
  overrides: Partial<AdapterMessage> = {}
): AdapterMessage {
  return {
    adapterId: 'a',
    conversationId: 'conv-1',
    text,
    senderName: 'Alice',
    senderId: '@alice:x',
    conversationKind: 'dm',
    ...overrides,
  };
}

/** The text passed to the backend's sendMessage (arg 1). */
function sentText(backend: SpawnBackend, call = 0): string {
  return (backend.sendMessage as ReturnType<typeof vi.fn>).mock.calls[
    call
  ][1] as string;
}

/** The options passed to the backend's sendMessage (arg 2). */
function sentOpts(
  backend: SpawnBackend,
  call = 0
): SendMessageOptions | undefined {
  return (backend.sendMessage as ReturnType<typeof vi.fn>).mock.calls[
    call
  ][2] as SendMessageOptions | undefined;
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

  it('tags a DM message with the sender name and attaches no room reminder', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('fix the build'));

    expect(sentText(backend)).toBe('[Alice] fix the build');
    expect(sentOpts(backend)).toBeUndefined();
  });

  it('falls back through senderId then "unknown" for the tag', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('a', { senderName: undefined }));
    await surface.handleMessage(
      msg('b', { senderName: undefined, senderId: undefined })
    );

    expect(sentText(backend, 0)).toBe('[@alice:x] a');
    expect(sentText(backend, 1)).toBe('[unknown] b');
  });

  it('attaches the room instruction for a room conversation', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(
      msg('anyone around?', { conversationKind: 'room' })
    );

    expect(sentText(backend)).toBe('[Alice] anyone around?');
    expect(sentOpts(backend)).toEqual({ systemReminder: ROOM_INSTRUCTION });
  });

  it('reuses the session for a second message', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('one'));
    await surface.handleMessage(msg('two'));

    expect(backend.spawnSession).toHaveBeenCalledTimes(1);
    expect(backend.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('joins a batch by newline with each line tagged', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleBatch?.([
      msg('first', { senderName: 'Alice' }),
      msg('second', {
        senderName: 'Bob',
        senderId: '@bob:x',
        conversationKind: 'room',
      }),
    ]);

    expect(backend.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentText(backend)).toBe('[Alice] first\n[Bob] second');
    // The room instruction is driven by the FIRST message's kind.
    expect(sentOpts(backend)).toBeUndefined();
  });

  it('attaches the room instruction when the batch is a room', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleBatch?.([
      msg('first', { conversationKind: 'room' }),
      msg('second', { senderName: 'Bob', conversationKind: 'room' }),
    ]);

    expect(sentOpts(backend)).toEqual({ systemReminder: ROOM_INSTRUCTION });
  });

  it('posts nothing when the agent replies with the no-response sentinel', async () => {
    const backend = makeBackend({
      sendMessage: vi.fn(async () => NO_RESPONSE_SENTINEL),
    });
    const surface = makeSurface(backend);

    const result = await surface.handleMessage(msg('hi'));

    expect(result).toEqual({ response: null, handled: true });
  });

  it('posts nothing when the backend returns a null reply', async () => {
    const backend = makeBackend({
      sendMessage: vi.fn(async () => null as string | null),
    });
    const surface = makeSurface(backend);

    const result = await surface.handleMessage(msg('hi'));

    expect(result).toEqual({ response: null, handled: true });
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
