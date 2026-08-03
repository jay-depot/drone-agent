/**
 * Tests for the /systemprompt slash command in the TUI.
 *
 * Verifies that the system prompt and prompt fragments are rendered
 * correctly when the user types /systemprompt.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';
import { createDefaultAgentConfig, type DroneChatMessage } from 'drone-core';

/**
 * Poll until `lastFrame()` satisfies `predicate` or `timeoutMs` elapses.
 *
 * Ink renders asynchronously; a fixed `setTimeout` is NOT a reliable
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

function makeOptions(
  overrides: Partial<DroneTuiOptions> = {}
): DroneTuiOptions {
  let model = 'llama3.1:latest';
  return {
    model,
    logger: silentLogger(),
    engine: {
      listTools: () => [],
      listPlugins: () => [
        {
          id: 'core',
          name: 'Core',
          enabled: true,
          required: true,
          defaultEnabled: true,
        },
      ],
      getRegisteredPluginCount: () => 1,
      getRegisteredToolCount: () => 0,
      getMountedToolCount: () => 0,
      getCapability: () => undefined,
      getTool: () => undefined,
      runHooks: async () => {},
      executeTool: async () => 'ok',
      getHelpSnippets: () => [],
      renderPromptFragments: async () => [
        'Fragment header content',
        'Fragment footer content',
      ],
      getConfig: () => ({
        ...createDefaultAgentConfig(),
        systemPrompt: 'You are a test agent.',
      }),
      buildSystemMessages: async () => {
        const base: DroneChatMessage[] = [
          { role: 'system', content: 'You are a test agent.' },
        ];
        base.push({ role: 'system', content: 'Fragment header content' });
        base.push({ role: 'system', content: 'Fragment footer content' });
        return base;
      },
      onConversationEvent: () => () => {},
      dispatchSlashCommand: async (_line, ctx) => {
        if (_line === '/systemprompt') {
          const systemMessages =
            (await ctx.engine.buildSystemMessages?.()) ?? [];
          const lines: string[] = ['System Messages:'];
          for (const msg of systemMessages) {
            lines.push('────────────────────────────────────────');
            lines.push(msg.content);
          }
          ctx.logger.info(lines.join('\n'));
          return true;
        }
        return false;
      },
      setElicitation: () => {},
      runWorkflow: async () => ({ toolResult: '{}' }),
      getSlashCommands: () => [],
    },
    conversation: {
      sendUserMessage: async () => 'reply',
      clearSession: () => {},
      getEstimatedContextUsagePercent: async () => 12,
      setModel: (m: string) => {
        model = m;
      },
      getModel: () => model,
      getReasoningLevel: () => undefined,
      setReasoningLevel: (_level: any) => {},
      getDebugSubsystems: () => [],
      enableDebugSubsystem: () => {},
      disableDebugSubsystem: () => {},
    },
    ...overrides,
  };
}

describe('App — /systemprompt', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('renders system prompt and prompt fragments', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('/systemprompt');
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('\r');
    const frame = await waitUntilFrame(
      instance,
      f =>
        f.includes('You are a test agent.') &&
        f.includes('Fragment header content') &&
        f.includes('Fragment footer content')
    );
    expect(frame).toContain('You are a test agent.');
    expect(frame).toContain('Fragment header content');
    expect(frame).toContain('Fragment footer content');
  });

  it('works when no prompt fragments are registered', async () => {
    const opts = makeOptions({
      engine: {
        listTools: () => [],
        listPlugins: () => [
          {
            id: 'core',
            name: 'Core',
            enabled: true,
            required: true,
            defaultEnabled: true,
          },
        ],
        getRegisteredPluginCount: () => 1,
        getRegisteredToolCount: () => 0,
        getMountedToolCount: () => 0,
        getCapability: () => undefined,
        getTool: () => undefined,
        runHooks: async () => {},
        executeTool: async () => 'ok',
        getHelpSnippets: () => [],
        renderPromptFragments: async () => [],
        getConfig: () => ({
          ...createDefaultAgentConfig(),
          systemPrompt: 'You are a test agent.',
        }),
        onConversationEvent: () => () => {},
        buildSystemMessages: async () => {
          const base: DroneChatMessage[] = [
            { role: 'system', content: 'You are a test agent.' },
          ];
          return base;
        },
        dispatchSlashCommand: async (_line, ctx) => {
          if (_line === '/systemprompt') {
            const systemMessages =
              (await ctx.engine.buildSystemMessages?.()) ?? [];
            const lines: string[] = ['System Messages:'];
            for (const msg of systemMessages) {
              lines.push('────────────────────────────────────────');
              lines.push(msg.content);
            }
            ctx.logger.info(lines.join('\n'));
            return true;
          }
          return false;
        },
        setElicitation: () => {},
        runWorkflow: async () => ({ toolResult: '{}' }),
        getSlashCommands: () => [],
      },
    });
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('/systemprompt');
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('\r');
    const frame = await waitUntilFrame(instance, f =>
      f.includes('You are a test agent.')
    );
    expect(frame).toContain('You are a test agent.');
  });
});
