/**
 * TUI test for `aside` event rendering.
 *
 * Fires an `aside` conversation event through the App's global listener and
 * asserts a committed `aside` scrollback entry appears (rendered via the
 * dedicated ChatEntry kind).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import type { ConversationEvent } from '../src/runtime/conversation-service.js';
import { silentLogger } from './helpers.js';

type ConvEvent = ConversationEvent;

/**
 * Poll until `lastFrame()` satisfies `predicate` or `timeoutMs` elapses.
 * Ink renders asynchronously; a fixed `setTimeout(0)` is not a reliable
 * barrier (it flakes on slower runners). Wait for the content instead.
 */
async function waitUntilFrame(
  inst: ReturnType<typeof render>,
  predicate: (frame: string) => boolean,
  timeoutMs = 1000
): Promise<string> {
  const start = Date.now();
  let frame = inst.lastFrame() ?? '';
  while (!predicate(frame) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
    frame = inst.lastFrame() ?? '';
  }
  return frame;
}

describe('App aside rendering', () => {
  let instance: ReturnType<typeof render> | null = null;
  let fire: ((e: ConvEvent) => void) | null = null;

  afterEach(() => {
    instance?.cleanup();
    instance = null;
    fire = null;
  });

  function makeApp() {
    const opts: DroneTuiOptions = {
      model: 'llama3.1:latest',
      logger: silentLogger(),
      engine: {
        listTools: () => [],
        listPlugins: () => [],
        getRegisteredPluginCount: () => 0,
        getRegisteredToolCount: () => 0,
        getMountedToolCount: () => 0,
        getCapability: () => undefined,
        getTool: () => undefined,
        runHooks: async () => {},
        executeTool: async () => 'ok',
        renderPromptFragments: async () => [],
        getConfig: () => {
          throw new Error('unused');
        },
        buildSystemMessages: async () => [],
        getHelpSnippets: () => [],
        dispatchSlashCommand: async () => false,
        onConversationEvent: cb => {
          fire = cb;
          return () => {};
        },
        setElicitation: () => {},
        runWorkflow: async () => ({ toolResult: '{}' }),
        getSlashCommands: () => [],
        classifySlashCommand: () => ({ kind: 'unknown' }),
      },
      conversation: {
        sendUserMessage: async () => 'reply',
        clearSession: () => {},
        getEstimatedContextUsagePercent: async () => 5,
        setModel: () => {},
        getModel: () => 'llama3.1:latest',
        getReasoningLevel: () => undefined,
        setReasoningLevel: () => {},
        enqueueUserMessage: () => {},
        cancelCurrentRequest: () => {},
        getDebugSubsystems: () => [],
        enableDebugSubsystem: () => {},
        disableDebugSubsystem: () => {},
      },
      sessionManager: {
        appendUserMessage: () => {},
        appendAssistantMessage: () => {},
        appendToolResult: () => {},
      },
    };
    instance = render(<App {...opts} />);
  }

  it('renders an aside as a committed scrollback entry with the question and answer', async () => {
    makeApp();
    expect(fire).toBeTruthy();

    fire!({
      kind: 'aside',
      question: 'what is the deploy command?',
      answer: 'It is make deploy.',
    });

    const frame = await waitUntilFrame(instance!, f =>
      f.includes('It is make deploy.')
    );
    expect(frame).toContain('btw');
    expect(frame).toContain('what is the deploy command?');
    expect(frame).toContain('It is make deploy.');
  });

  it('commits the aside immediately (does not require a completion event)', async () => {
    makeApp();
    fire!({ kind: 'aside', question: 'q?', answer: 'a.' });
    const frame = await waitUntilFrame(instance!, f => f.includes('a.'));
    expect(frame).toContain('q?');
  });
});
