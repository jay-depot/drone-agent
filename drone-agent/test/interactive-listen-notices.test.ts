/**
 * Notice forwarding in the non-TUI listen hosts.
 *
 * Reference-expansion notices (the `[expanded @…]` receipt, unresolved/binary
 * warnings) are emitted through the engine's conversation-event hooks, which do
 * NOT reach the per-turn handler passed to `sendUserMessage`. Both listen hosts
 * must therefore observe them through a global `onConversationEvent` listener.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: 'chat', message: 'see @x.ts' });
    },
    close: () => {},
  }),
}));

import { runJsonListenMode, runSwarmListenMode } from '../src/interactive.js';

type EventListener = (event: { kind: string; content?: string }) => void;

function makeEngine(): {
  engine: {
    onConversationEvent: (cb: EventListener) => () => void;
    runConversationEventHooks: (event: {
      kind: string;
      content?: string;
    }) => Promise<void>;
    runHooks: () => Promise<void>;
  };
} {
  const listeners: EventListener[] = [];
  return {
    engine: {
      onConversationEvent: (cb: EventListener) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
      runConversationEventHooks: async event => {
        for (const cb of [...listeners]) cb(event);
      },
      runHooks: async () => {},
    },
  };
}

describe('listen-host notice forwarding', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function written(): string {
    return stdoutWriteSpy.mock.calls.map(call => String(call[0])).join('');
  }

  it('json-listen forwards an expansion notice emitted through the hooks', async () => {
    const { engine } = makeEngine();
    const conversation = {
      sendUserMessage: async () => {
        // Mirror the conversation service: expansion notices ride the hooks,
        // never the per-turn handler.
        await engine.runConversationEventHooks({
          kind: 'notice',
          content: '[expanded @x.ts (1 lines, 5 B)]',
        });
        return 'done';
      },
    };

    await runJsonListenMode(
      conversation as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );

    const out = written();
    expect(out).toContain('"kind":"notice"');
    expect(out).toContain('[expanded @x.ts (1 lines, 5 B)]');
  });

  it('swarm-listen forwards an expansion notice', async () => {
    const { engine } = makeEngine();
    let resolveSignal: (() => void) | undefined;
    // Intercept the signal registration so the test never emits a real signal
    // into the worker process; the captured resolver ends the listen loop.
    vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: () => void
    ) => {
      if (event === 'SIGTERM') resolveSignal = listener;
      return process;
    }) as typeof process.once);

    const running = runSwarmListenMode(
      engine as unknown as Parameters<typeof runSwarmListenMode>[0]
    );

    await engine.runConversationEventHooks({
      kind: 'notice',
      content: '[expanded @y.ts (2 lines, 9 B)]',
    });
    resolveSignal?.();
    await running;

    const out = written();
    expect(out).toContain('"kind":"notice"');
    expect(out).toContain('[expanded @y.ts (2 lines, 9 B)]');
  });
});
