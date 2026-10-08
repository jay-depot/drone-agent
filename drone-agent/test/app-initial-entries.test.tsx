/**
 * TUI test: startup chat-log entries seeded on mount.
 *
 * The host surfaces work that ran before the App subscribed (e.g. a
 * `--swarm.session-import` summary) via `DroneTuiOptions.initialEntries`.
 * Those entries must be committed to the scrollback on first render.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';

/**
 * Poll until `lastFrame()` satisfies `predicate` or the timeout elapses.
 * Ink renders asynchronously; a fixed setTimeout barrier is not reliable.
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

function makeOptions(extra: Partial<DroneTuiOptions> = {}): DroneTuiOptions {
  return {
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
      onConversationEvent: () => () => {},
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
      getDebugSubsystems: () => [],
      enableDebugSubsystem: () => {},
      disableDebugSubsystem: () => {},
    },
    sessionManager: {
      appendUserMessage: () => {},
      appendAssistantMessage: () => {},
      appendToolResult: () => {},
    },
    ...extra,
  };
}

describe('App initialEntries seeding', () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.cleanup();
    instance = null;
  });

  it('commits initialEntries to the scrollback on mount', async () => {
    instance = render(
      <App
        {...makeOptions({
          initialEntries: [
            {
              id: 'startup-session-import',
              kind: 'notice',
              text: 'session-import: imported 2 chunk(s) from old1',
            },
          ],
        })}
      />
    );

    const frame = await waitUntilFrame(instance, f =>
      f.includes('session-import: imported 2 chunk(s) from old1')
    );
    expect(frame).toContain('session-import: imported 2 chunk(s) from old1');
  });

  it('renders no seeded entry when initialEntries is absent', async () => {
    instance = render(<App {...makeOptions()} />);
    // Wait for the input prompt to confirm the App mounted, then assert the
    // startup text is absent.
    const frame = await waitUntilFrame(instance, f => f.includes('drone>'));
    expect(frame).not.toContain('session-import:');
  });
});
