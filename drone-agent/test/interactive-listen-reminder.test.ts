/**
 * `systemReminder` forwarding in the non-TUI JSON listen host.
 *
 * A chat event may carry a per-turn `systemReminder` (e.g. the gateway's room
 * "decide whether to respond" instruction). `runJsonListenMode` must queue it
 * on the engine as a non-persisted system reminder before the turn runs.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { inputLines } = vi.hoisted(() => ({ inputLines: [] as string[] }));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      for (const line of inputLines) yield line;
    },
    close: () => {},
  }),
}));

import { runJsonListenMode } from '../src/interactive.js';

function makeEngine() {
  const reminders: string[] = [];
  const sent: string[] = [];
  const engine = {
    queueSystemReminder: (content: string) => {
      reminders.push(content);
    },
    onConversationEvent: () => () => {},
    runConversationEventHooks: async () => {},
    runHooks: async () => {},
  };
  const conversation = {
    sendUserMessage: async (prompt: string) => {
      sent.push(prompt);
      return 'ok';
    },
  };
  return { engine, conversation, reminders, sent };
}

describe('json-listen systemReminder forwarding', () => {
  beforeEach(() => {
    inputLines.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function run(
    engine: ReturnType<typeof makeEngine>['engine'],
    conversation: ReturnType<typeof makeEngine>['conversation']
  ) {
    return runJsonListenMode(
      conversation as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );
  }

  it('queues a reminder carried on the chat event before the turn', async () => {
    inputLines.push(
      JSON.stringify({
        type: 'chat',
        message: 'hi',
        systemReminder: 'ROOM-INSTRUCTION',
      })
    );
    const { engine, conversation, reminders, sent } = makeEngine();

    await run(engine, conversation);

    expect(sent).toEqual(['hi']);
    expect(reminders).toEqual(['ROOM-INSTRUCTION']);
  });

  it('queues nothing when the chat event has no reminder', async () => {
    inputLines.push(JSON.stringify({ type: 'chat', message: 'hi' }));
    const { engine, conversation, reminders } = makeEngine();

    await run(engine, conversation);

    expect(reminders).toEqual([]);
  });

  it('ignores a blank reminder', async () => {
    inputLines.push(
      JSON.stringify({ type: 'chat', message: 'hi', systemReminder: '   ' })
    );
    const { engine, conversation, reminders } = makeEngine();

    await run(engine, conversation);

    expect(reminders).toEqual([]);
  });
});
