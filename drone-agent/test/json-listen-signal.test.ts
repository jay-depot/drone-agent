/**
 * Universal SIGTERM/SIGINT handling in the JSON listen mode.
 *
 * `runJsonListenMode` is the gateway's persistent mode: a SIGTERM/SIGINT must
 * soft-cancel the in-flight turn (`runtime.cancelCurrentRequest`) and close the
 * readline interface so the `for await` loop returns normally. Only then does
 * the caller in index.tsx run the `onShutdown` hooks. Handlers must be
 * registered before the loop and removed afterwards.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// A readline fake that behaves like a real line-stream: the async iterator
// yields pushed lines as they arrive and resolves to done when close() is
// called (waking any pending wait).
vi.mock('node:readline/promises', () => {
  const state = {
    lines: [] as string[],
    closeCalls: 0,
    closed: false,
    waiters: [] as Array<() => void>,
    push: (line: string) => {
      state.lines.push(line);
      const waiters = state.waiters.splice(0);
      for (const w of waiters) w();
    },
  };
  return {
    createInterface: () => ({
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (state.lines.length > 0) {
            yield state.lines.shift();
            continue;
          }
          if (state.closed) return;
          await new Promise<void>(resolve => {
            state.waiters.push(resolve);
          });
        }
      },
      close: () => {
        state.closeCalls += 1;
        state.closed = true;
        const waiters = state.waiters.splice(0);
        for (const w of waiters) w();
      },
    }),
    __state: state,
  };
});

// Import after the mock is installed.
import { runJsonListenMode } from '../src/interactive.js';
type MockedReadline = typeof import('node:readline/promises') & {
  __state: {
    lines: string[];
    closeCalls: number;
    closed: boolean;
    waiters: Array<() => void>;
    push: (line: string) => void;
  };
};
const readlineState =
  (await import('node:readline/promises')) as unknown as MockedReadline;

type EventListener = (event: { kind: string; content?: string }) => void;

function makeEngine(cancelCurrentRequest?: () => void): {
  engine: {
    getCapability: <T>(_id: string) => T | undefined;
    onConversationEvent: (cb: EventListener) => () => void;
    runHooks: () => Promise<void>;
    queueSystemReminder: () => void;
  };
} {
  const listeners: EventListener[] = [];
  const engine = {
    getCapability: <T>(_id: string) =>
      ({ cancelCurrentRequest }) as unknown as T | undefined,
    onConversationEvent: (cb: EventListener) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    runHooks: async () => {},
    queueSystemReminder: () => {},
  };
  return { engine };
}

describe('json-listen signal handling', () => {
  beforeEach(() => {
    readlineState.__state.lines.length = 0;
    readlineState.__state.closeCalls = 0;
    readlineState.__state.closed = false;
    readlineState.__state.waiters.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureSignalHandlers(): {
    signalHandlers: Map<string, () => void>;
  } {
    const signalHandlers = new Map<string, () => void>();
    vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: () => void
    ) => {
      signalHandlers.set(event, listener);
      return process;
    }) as typeof process.once);
    vi.spyOn(process, 'removeListener').mockImplementation(
      (() => process) as typeof process.removeListener
    );
    return { signalHandlers };
  }

  it('registers SIGTERM/SIGINT handlers that cancel the request and end the loop', async () => {
    const { signalHandlers } = captureSignalHandlers();
    const cancelCurrentRequest = vi.fn();
    const { engine } = makeEngine(cancelCurrentRequest);
    const conversation = {
      sendUserMessage: async () => 'done',
    };

    const running = runJsonListenMode(
      conversation as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );
    // Let the handlers register before firing the signal.
    await Promise.resolve();

    expect(signalHandlers.has('SIGTERM')).toBe(true);
    expect(signalHandlers.has('SIGINT')).toBe(true);

    signalHandlers.get('SIGTERM')?.();

    await running;
    expect(cancelCurrentRequest).toHaveBeenCalled();
    expect(readlineState.__state.closeCalls).toBeGreaterThan(0);
  });

  it('removes the signal handlers in the finally block after the loop ends', async () => {
    const { signalHandlers } = captureSignalHandlers();
    const removeListenerSpy = vi.spyOn(process, 'removeListener');
    const { engine } = makeEngine(vi.fn());
    const conversation = {
      sendUserMessage: async () => 'done',
    };

    const running = runJsonListenMode(
      conversation as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );
    await Promise.resolve();

    const sigtermHandler = signalHandlers.get('SIGTERM');
    const sigintHandler = signalHandlers.get('SIGINT');

    signalHandlers.get('SIGINT')?.();
    await running;

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', sigintHandler);
  });

  it('cancels a turn in flight when a signal arrives mid-conversation', async () => {
    const { signalHandlers } = captureSignalHandlers();
    // cancelCurrentRequest must settle the in-flight turn (mark it cancelled)
    // so the loop can observe the closed readline and return. This mirrors
    // the real conversation service, where the soft-cancel rejects/resolves
    // the pending sendUserMessage.
    let releaseTurn: (() => void) | undefined;
    const cancelCurrentRequest = vi.fn(() => {
      releaseTurn?.();
    });
    const { engine } = makeEngine(cancelCurrentRequest);

    const conversation = {
      sendUserMessage: () =>
        new Promise<string>(resolve => {
          releaseTurn = () => resolve('cancelled');
        }),
    };

    const running = runJsonListenMode(
      conversation as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );
    await Promise.resolve();

    readlineState.__state.push(JSON.stringify({ type: 'chat', message: 'hi' }));
    // The async iterator needs a few turns to yield the line and reach
    // sendUserMessage; poll rather than assuming a fixed tick count.
    const deadline = Date.now() + 2000;
    while (!releaseTurn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(releaseTurn).toBeTypeOf('function');

    // SIGTERM during the in-flight turn: cancel + close ends the loop.
    signalHandlers.get('SIGTERM')?.();
    await running;

    expect(cancelCurrentRequest).toHaveBeenCalled();
  });
});
