/**
 * SIGTERM/SIGINT handling in the one-shot JSON mode (`runJsonMode`).
 *
 * `runJsonMode` reads a kickoff from stdin and runs one turn. A SIGTERM or
 * SIGINT must cancel the in-flight turn (`runtime.cancelCurrentRequest`) so the
 * turn settles as an error and control returns to `main()`, which runs the
 * `onShutdown` hooks. Handlers must be registered before the turn and removed
 * afterwards.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:readline/promises', () => {
  const state = { lines: [] as string[] };
  return {
    createInterface: () => ({
      async *[Symbol.asyncIterator]() {
        while (state.lines.length > 0) {
          yield state.lines.shift();
        }
      },
      close: () => {},
    }),
    __state: state,
  };
});

import { runJsonMode } from '../src/interactive.js';

type MockedReadline = typeof import('node:readline/promises') & {
  __state: { lines: string[] };
};
const readlineState =
  (await import('node:readline/promises')) as unknown as MockedReadline;

function makeEngine(cancelCurrentRequest?: () => void): {
  engine: {
    getCapability: <T>(_id: string) => T | undefined;
    runHooks: () => Promise<void>;
  };
} {
  const engine = {
    getCapability: <T>(_id: string) =>
      ({ cancelCurrentRequest }) as unknown as T | undefined,
    runHooks: async () => {},
  };
  return { engine };
}

function kickoffLine(task = 'do the thing'): string {
  return JSON.stringify({ type: 'kickoff', task });
}

describe('runJsonMode signal handling', () => {
  beforeEach(() => {
    readlineState.__state.lines.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  function captureSignalHandlers(): {
    signalHandlers: Map<string, () => void>;
    removeListenerSpy: ReturnType<typeof vi.spyOn>;
  } {
    const signalHandlers = new Map<string, () => void>();
    vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: () => void
    ) => {
      signalHandlers.set(event, listener);
      return process;
    }) as typeof process.once);
    const removeListenerSpy = vi
      .spyOn(process, 'removeListener')
      .mockImplementation((() => process) as typeof process.removeListener);
    return { signalHandlers, removeListenerSpy };
  }

  it('registers a SIGTERM and a SIGINT handler', async () => {
    const { signalHandlers } = captureSignalHandlers();
    readlineState.__state.lines.push(kickoffLine());
    const { engine } = makeEngine(vi.fn());
    const conversation = { sendUserMessage: async () => 'done' };

    await runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    expect(signalHandlers.has('SIGTERM')).toBe(true);
    expect(signalHandlers.has('SIGINT')).toBe(true);
  });

  it('cancels the in-flight turn when a SIGTERM arrives', async () => {
    const { signalHandlers } = captureSignalHandlers();
    let releaseTurn: (() => void) | undefined;
    const cancelCurrentRequest = vi.fn(() => releaseTurn?.());
    const { engine } = makeEngine(cancelCurrentRequest);
    const conversation = {
      sendUserMessage: () =>
        new Promise<string>(resolve => {
          releaseTurn = () => resolve('cancelled');
        }),
    };
    readlineState.__state.lines.push(kickoffLine());

    const running = runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    const deadline = Date.now() + 2000;
    while (!releaseTurn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(releaseTurn).toBeTypeOf('function');

    signalHandlers.get('SIGTERM')?.();
    await running;

    expect(cancelCurrentRequest).toHaveBeenCalled();
  });

  it('sets process.exitCode to 1 when the turn is interrupted', async () => {
    const { signalHandlers } = captureSignalHandlers();
    let releaseTurn: (() => void) | undefined;
    const cancelCurrentRequest = vi.fn(() => releaseTurn?.());
    const { engine } = makeEngine(cancelCurrentRequest);
    const conversation = {
      sendUserMessage: () =>
        new Promise<string>((_resolve, reject) => {
          releaseTurn = () => reject(new Error('Request cancelled'));
        }),
    };
    readlineState.__state.lines.push(kickoffLine());

    const running = runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    const deadline = Date.now() + 2000;
    while (!releaseTurn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    signalHandlers.get('SIGTERM')?.();
    await running;

    expect(process.exitCode).toBe(1);
  });

  it('removes the handlers after the turn with the captured references', async () => {
    const { signalHandlers, removeListenerSpy } = captureSignalHandlers();
    readlineState.__state.lines.push(kickoffLine());
    const { engine } = makeEngine(vi.fn());
    const conversation = { sendUserMessage: async () => 'done' };

    await runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    const sigtermHandler = signalHandlers.get('SIGTERM');
    const sigintHandler = signalHandlers.get('SIGINT');
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', sigintHandler);
  });

  void (null as unknown as EventListener);
});
