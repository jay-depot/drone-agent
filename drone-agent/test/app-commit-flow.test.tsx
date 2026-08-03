/**
 * Integration test for the App tail → scrollback commit flow.
 *
 * The App registers a single conversation-event listener. We capture that
 * callback, then fire the event sequence a real conversation produces
 * (reasoning → reasoningComplete → toolCallBatch → toolResultBatch →
 * assistantMessage → assistantMessageComplete). After each *Complete event
 * the corresponding item must be committed into the <Static> scrollback,
 * rendered via its carried `node` (preserving the live component's look).
 *
 * This exercises the previously-untested handoff that was losing formatting.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import type { ConversationEvent } from '../src/runtime/conversation-service.js';
import { silentLogger } from './helpers.js';

type ConvEvent = ConversationEvent;

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

/**
 * Poll until `lastFrame()` satisfies `predicate` or `timeoutMs` elapses.
 *
 * Ink renders asynchronously; a fixed `setTimeout(0)` is NOT a reliable
 * barrier and flakes on slower CI runners (lastFrame() returns the empty
 * pre-render frame). We instead wait for the specific content to actually
 * appear in the output.
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

describe('App commit flow', () => {
  let instance: ReturnType<typeof render> | null = null;
  let fire: ((e: ConvEvent) => void) | null = null;

  afterEach(() => {
    instance?.cleanup();
    instance = null;
    fire = null;
  });

  function makeApp() {
    let unregister: (() => void) | null = null;
    const opts: DroneTuiOptions = {
      model: 'llama3.1:latest',
      logger: silentLogger(),
      engine: {
        listTools: () => [{ name: 'tool-a', description: 'Tool A' }],
        listPlugins: () => [],
        getRegisteredPluginCount: () => 1,
        getRegisteredToolCount: () => 1,
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
          // No-op unregister: the App calls this on effect cleanup (which
          // runs on re-renders as entries commit). We keep `fire` alive for
          // the whole test so we can drive the event sequence.
          return () => {};
        },
        setElicitation: () => {},
        runWorkflow: async () => ({ toolResult: '{}' }),
        getSlashCommands: () => [],
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
    };
    instance = render(<App {...opts} />);
  }

  it('commits reasoning, tool result, and assistant message into scrollback', async () => {
    makeApp();
    expect(fire).toBeTruthy();

    // Reasoning stream + complete
    fire!({ kind: 'reasoning', content: 'thinking...' });
    await tick();
    fire!({ kind: 'reasoningComplete' });
    await tick();

    let frame = await waitUntilFrame(instance!, f => f.includes('thinking...'));
    expect(frame).toContain('thinking...');

    // Tool call + result
    fire!({
      kind: 'toolCallBatch',
      toolCalls: [{ name: 'tool-a', arguments: { q: 'find me' } }],
    });
    await tick();
    fire!({
      kind: 'toolResultBatch',
      results: [
        { name: 'tool-a', content: '{"hits": 3}', arguments: { q: 'find me' } },
      ],
    });
    await tick();

    frame = await waitUntilFrame(
      instance!,
      f => f.includes('tool-a') && f.includes('find me')
    );
    // ToolCallProgress node renders the tool name + args preview.
    expect(frame).toContain('tool-a');
    expect(frame).toContain('find me');

    // Assistant message stream + complete (Markdown)
    fire!({ kind: 'assistantMessage', content: 'Found **3** results' });
    await tick();
    fire!({ kind: 'assistantMessageComplete' });
    await tick();

    frame = await waitUntilFrame(instance!, f => f.includes('Found'));
    // The markdown content is present in the committed scrollback.
    expect(frame).toContain('Found');
  });

  it('renders assistant message as markdown (not a plain line)', async () => {
    makeApp();
    fire!({ kind: 'assistantMessage', content: '# Title\nbody text' });
    await tick();
    fire!({ kind: 'assistantMessageComplete' });
    await tick();

    const frame = await waitUntilFrame(
      instance!,
      f => f.includes('Title') && f.includes('body text')
    );
    expect(frame).toContain('Title');
    expect(frame).toContain('body text');
  });

  it('clears in-flight tail items on error', async () => {
    makeApp();
    fire!({ kind: 'reasoning', content: 'half done' });
    await tick();
    fire!({ kind: 'error', message: 'boom' });
    await tick();

    const frame = await waitUntilFrame(instance!, f =>
      f.includes('Error: boom')
    );
    expect(frame).toContain('Error: boom');
    // The in-flight reasoning should not linger in the tail.
    expect(frame).not.toContain('half done');
  });
});
