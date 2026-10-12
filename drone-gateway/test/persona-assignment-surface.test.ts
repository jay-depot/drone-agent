import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPersonaAssignmentSurface } from '../src/surfaces/persona-assignment.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../src/surfaces/lifecycle.js';
import {
  CANCEL_SENTINEL,
  MENTION_INSTRUCTION,
  NO_RESPONSE_SENTINEL,
  OBSERVER_INSTRUCTION,
  ROOM_INSTRUCTION,
} from '../src/chat-format.js';
import { logger } from '../src/logger.js';
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
    exportContext: vi.fn(),
    importContext: vi.fn(),
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
    mode: ctxOverrides.mode ?? 'active',
    catchUpIntervalMs: ctxOverrides.catchUpIntervalMs ?? 900_000,
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
        mode: 'active',
        catchUpIntervalMs: 900_000,
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

    expect(sentText(backend)).toBe('[- from: Alice]\nfix the build');
    expect(sentOpts(backend)).toBeUndefined();
  });

  it('falls back through senderId then "unknown" for the tag', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(msg('a', { senderName: undefined }));
    await surface.handleMessage(
      msg('b', { senderName: undefined, senderId: undefined })
    );

    expect(sentText(backend, 0)).toBe('[- from: @alice:x]\na');
    expect(sentText(backend, 1)).toBe('[- from: unknown]\nb');
  });

  it('attaches the room instruction for a room conversation', async () => {
    const backend = makeBackend();
    const surface = makeSurface(backend);

    await surface.handleMessage(
      msg('anyone around?', { conversationKind: 'room' })
    );

    expect(sentText(backend)).toBe('[- from: Alice]\nanyone around?');
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
    expect(sentText(backend)).toBe(
      '[- from: Alice]\nfirst\n[- from: Bob]\nsecond'
    );
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

  describe('outbound ledger drain', () => {
    function makeLedger(
      entries: Array<{ id: number; platformRef?: string; text: string }>
    ) {
      return {
        append: vi.fn(),
        list: vi.fn(() => entries.map(e => ({ ...e, createdAt: 0 }))),
        remove: vi.fn(),
      };
    }

    it('prepends the preamble and posts entries, deleting rows on success', async () => {
      const backend = makeBackend();
      const ledger = makeLedger([
        { id: 1, platformRef: '$post1', text: 'news' },
        { id: 2, text: 'more news' },
      ]);
      const surface = makeSurface(backend, { outboundLedger: ledger });

      await surface.handleMessage(msg('hi'));

      expect(sentText(backend)).toBe(
        'Messages you posted to this conversation while you were not running:\n' +
          '[$post1 posted by you]\nnews\n' +
          '[- posted by you]\nmore news\n\n' +
          '[- from: Alice]\nhi'
      );
      expect(ledger.remove).toHaveBeenCalledWith([1, 2]);
    });

    it('does not delete rows when the turn throws', async () => {
      const backend = makeBackend({
        spawnSession: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      const ledger = makeLedger([{ id: 1, text: 'news' }]);
      const surface = makeSurface(backend, { outboundLedger: ledger });

      const result = await surface.handleMessage(msg('hi'));

      expect(result.response).toBe('Error: boom');
      expect(ledger.remove).not.toHaveBeenCalled();
    });

    it('leaves the text unchanged when there is no ledger handle', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend);
      await surface.handleMessage(msg('fix the build'));
      expect(sentText(backend)).toBe('[- from: Alice]\nfix the build');
    });

    it('leaves the text unchanged when the ledger is empty', async () => {
      const backend = makeBackend();
      const ledger = makeLedger([]);
      const surface = makeSurface(backend, { outboundLedger: ledger });
      await surface.handleMessage(msg('hi'));
      expect(sentText(backend)).toBe('[- from: Alice]\nhi');
      expect(ledger.remove).not.toHaveBeenCalled();
    });

    it('drains the preamble once alongside a room batch reminder', async () => {
      const backend = makeBackend();
      const ledger = makeLedger([{ id: 7, platformRef: '$p', text: 'brief' }]);
      const surface = makeSurface(backend, { outboundLedger: ledger });

      await surface.handleBatch?.([
        msg('first', { conversationKind: 'room' }),
        msg('second', { senderName: 'Bob', conversationKind: 'room' }),
      ]);

      expect(sentText(backend)).toBe(
        'Messages you posted to this conversation while you were not running:\n' +
          '[$p posted by you]\nbrief\n\n' +
          '[- from: Alice]\nfirst\n[- from: Bob]\nsecond'
      );
      expect(sentOpts(backend)).toEqual({ systemReminder: ROOM_INSTRUCTION });
      expect(ledger.remove).toHaveBeenCalledWith([7]);
    });
  });

  describe('observer mode', () => {
    it('buffers messages and never sends until the catch-up timer fires', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      const first = await surface.handleMessage(msg('one'));
      const second = await surface.handleMessage(
        msg('two', { senderName: 'Bob', senderId: '@bob:x' })
      );

      expect(backend.sendMessage).not.toHaveBeenCalled();
      expect(backend.spawnSession).not.toHaveBeenCalled();
      expect(first).toEqual({ response: null, handled: true });
      expect(second).toEqual({ response: null, handled: true });

      await vi.advanceTimersByTimeAsync(1000);

      expect(backend.sendMessage).toHaveBeenCalledTimes(1);
      expect(sentText(backend)).toBe(
        '[- from: Alice]\none\n[- from: Bob]\ntwo'
      );
      expect(sentOpts(backend)).toEqual({
        systemReminder: OBSERVER_INSTRUCTION,
      });
    });

    it('still discards a buffered message after a flush returned text', async () => {
      const backend = makeBackend(); // returns 'hello back'
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      await surface.handleMessage(msg('one'));
      await vi.advanceTimersByTimeAsync(1000);

      // A fresh ingest after a text-returning flush is still silent.
      const result = await surface.handleMessage(msg('two'));
      expect(result).toEqual({ response: null, handled: true });
    });

    it('never arms the timer when the catch-up interval is 0', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 0,
      });

      await surface.handleBatch?.([msg('one'), msg('two')]);
      await vi.advanceTimersByTimeAsync(10_000_000);

      expect(backend.sendMessage).not.toHaveBeenCalled();
      expect(backend.spawnSession).not.toHaveBeenCalled();
    });

    it('is a no-op on an empty tick (no spawn, no send)', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(backend.spawnSession).not.toHaveBeenCalled();
      expect(backend.sendMessage).not.toHaveBeenCalled();
      expect(surface.id).toBe('persona-assignment-conv-1');
    });

    it('logs (and posts nothing for) an Error: reply from a catch-up turn', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const backend = makeBackend({
        sendMessage: vi.fn(async () => 'Error: boom'),
      });
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      await surface.handleMessage(msg('one'));
      await vi.advanceTimersByTimeAsync(1000);

      const calls = warn.mock.calls.filter(call =>
        String(call[1]).includes('Agent turn failed')
      );
      expect(calls).toHaveLength(1);
      warn.mockRestore();
    });

    it('clears the timer on dispose (no further flush)', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      await surface.handleMessage(msg('one'));
      await surface.dispose?.();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(backend.sendMessage).not.toHaveBeenCalled();
    });

    it('drains atomically: an arrival during a flush lands in the next window', async () => {
      let resolveFirst: (() => void) | undefined;
      const backend = makeBackend({
        sendMessage: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<string>(resolve => {
                resolveFirst = () => resolve('first done');
              })
          )
          .mockImplementation(async () => 'second done'),
      });
      const surface = makeSurface(backend, {
        mode: 'observer',
        catchUpIntervalMs: 1000,
      });

      await surface.handleMessage(msg('one'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(backend.sendMessage).toHaveBeenCalledTimes(1);

      // Arrives while the first flush is still in flight.
      await surface.handleMessage(msg('two'));
      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(1000);

      expect(backend.sendMessage).toHaveBeenCalledTimes(2);
      expect(sentText(backend, 0)).toBe('[- from: Alice]\none');
      expect(sentText(backend, 1)).toBe('[- from: Alice]\ntwo');
    });
  });

  describe('passive mode', () => {
    it('buffers, then posts exactly one reply on a mention', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'passive',
        catchUpIntervalMs: 1000,
      });

      await surface.handleMessage(msg('first'));
      await surface.handleMessage(msg('second', { senderName: 'Bob' }));
      expect(backend.sendMessage).not.toHaveBeenCalled();

      const result = await surface.handleMessage(
        msg('hey bot', { mentionsBot: true })
      );

      expect(backend.sendMessage).toHaveBeenCalledTimes(1);
      expect(sentText(backend)).toBe(
        '[- from: Alice]\nfirst\n[- from: Bob]\nsecond\n[- from: Alice]\nhey bot'
      );
      expect(sentOpts(backend)).toEqual({
        systemReminder: MENTION_INSTRUCTION,
      });
      expect(result).toEqual({ response: 'hello back', handled: true });
    });

    it('discards the reply of an ordinary (non-mention) timer flush', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend, {
        mode: 'passive',
        catchUpIntervalMs: 1000,
      });

      const result = await surface.handleMessage(msg('first'));
      expect(result).toEqual({ response: null, handled: true });

      await vi.advanceTimersByTimeAsync(1000);

      expect(backend.sendMessage).toHaveBeenCalledTimes(1);
      expect(sentOpts(backend)).toEqual({
        systemReminder: OBSERVER_INSTRUCTION,
      });
    });

    it('is a no-op on an empty tick', async () => {
      const backend = makeBackend();
      makeSurface(backend, { mode: 'passive', catchUpIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(5000);

      expect(backend.spawnSession).not.toHaveBeenCalled();
      expect(backend.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('reply-block and sentinel handling by mode', () => {
    it('posts nothing and logs when an active turn is cancelled', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
      const backend = makeBackend({
        sendMessage: vi.fn(async () => CANCEL_SENTINEL),
      });
      const surface = makeSurface(backend);

      const result = await surface.handleMessage(msg('hi'));

      expect(result).toEqual({ response: null, handled: true });
      const cancelled = info.mock.calls.filter(call =>
        String(call[1]).includes('cancelled')
      );
      expect(cancelled).toHaveLength(1);
      info.mockRestore();
    });

    it('posts nothing when a mention round is cancelled', async () => {
      const backend = makeBackend({
        sendMessage: vi.fn(async () => CANCEL_SENTINEL),
      });
      const surface = makeSurface(backend, {
        mode: 'passive',
        catchUpIntervalMs: 1000,
      });

      const result = await surface.handleMessage(
        msg('hey bot', { mentionsBot: true })
      );

      expect(result).toEqual({ response: null, handled: true });
    });

    it('returns an Error: reply in active mode but not in a discarding mode', async () => {
      const activeBackend = makeBackend({
        sendMessage: vi.fn(async () => 'Error: boom'),
      });
      const activeSurface = makeSurface(activeBackend);
      const activeResult = await activeSurface.handleMessage(msg('hi'));
      expect(activeResult).toEqual({ response: 'Error: boom', handled: true });

      const passiveBackend = makeBackend({
        sendMessage: vi.fn(async () => 'Error: boom'),
      });
      const passiveSurface = makeSurface(passiveBackend, {
        mode: 'passive',
        catchUpIntervalMs: 1000,
      });
      const passiveResult = await passiveSurface.handleMessage(
        msg('hey bot', { mentionsBot: true })
      );
      expect(passiveResult).toEqual({ response: null, handled: true });
    });

    it('ignores mentionsBot in active mode', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend);

      const result = await surface.handleMessage(
        msg('hi', { mentionsBot: true })
      );

      expect(result).toEqual({ response: 'hello back', handled: true });
      expect(backend.sendMessage).toHaveBeenCalledTimes(1);
      expect(sentOpts(backend)).toBeUndefined();
    });

    it('uses the room reminder for an active room mention (unchanged)', async () => {
      const backend = makeBackend();
      const surface = makeSurface(backend);

      await surface.handleMessage(
        msg('hi', { conversationKind: 'room', mentionsBot: true })
      );

      expect(sentOpts(backend)).toEqual({ systemReminder: ROOM_INSTRUCTION });
    });
  });
});
