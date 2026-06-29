/**
 * Tests for the /systemprompt slash command.
 *
 * Covers:
 *   - Engine.getConfig() returns the config object
 *   - TUI /systemprompt renders the base system prompt and fragments
 *   - TUI /systemprompt works when no fragments are registered
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createDefaultAgentConfig, type DroneAgentConfig } from 'drone-core';
import { App } from '../src/tui/app.js';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';
import type { DroneTuiOptions } from '../src/tui/types.js';

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
      getCapability: () => undefined,
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
      dispatchSlashCommand: async (_line, ctx) => {
        // Handle /systemprompt by calling the engine methods directly
        if (_line === '/systemprompt') {
          const fragments = (await ctx.engine.renderPromptFragments?.()) ?? [];
          const config = ctx.engine.getConfig?.();
          const lines: string[] = [
            'System Prompt:',
            '────────────────────────────────────────',
            config?.systemPrompt ?? '(not available)',
          ];
          if (fragments.length > 0) {
            lines.push('────────────────────────────────────────');
            lines.push('Prompt Fragments:');
            for (const fragment of fragments) {
              lines.push('────────────────────────────────────────');
              lines.push(fragment);
            }
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
    },
    ...overrides,
  };
}

describe('engine.getConfig', () => {
  it('returns the config object passed to the engine', async () => {
    const config: DroneAgentConfig = {
      ...createDefaultAgentConfig(),
      systemPrompt: 'Custom system prompt for testing',
    };

    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'test' })],
      config,
      logger: silentLogger(),
    });

    await engine.initialize();
    expect(engine.getConfig()).toBe(config);
    expect(engine.getConfig().systemPrompt).toBe(
      'Custom system prompt for testing'
    );
  });
});

describe('TUI /systemprompt', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('renders the base system prompt and fragments', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    for (const ch of '/systemprompt') {
      instance.stdin.write(ch);
      await new Promise(r => setTimeout(r, 20));
    }
    instance.stdin.write('\r');
    await new Promise(r => setTimeout(r, 100));
    const frame = instance.lastFrame() ?? '';
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
        getCapability: () => undefined,
        runHooks: async () => {},
        executeTool: async () => 'ok',
        getHelpSnippets: () => [],
        renderPromptFragments: async () => [],
        getConfig: () => ({
          ...createDefaultAgentConfig(),
          systemPrompt: 'You are a test agent.',
        }),
        dispatchSlashCommand: async (_line, ctx) => {
          if (_line === '/systemprompt') {
            const fragments =
              (await ctx.engine.renderPromptFragments?.()) ?? [];
            const config = ctx.engine.getConfig?.();
            const lines: string[] = [
              'System Prompt:',
              '────────────────────────────────────────',
              config?.systemPrompt ?? '(not available)',
            ];
            if (fragments.length > 0) {
              lines.push('────────────────────────────────────────');
              lines.push('Prompt Fragments:');
              for (const fragment of fragments) {
                lines.push('────────────────────────────────────────');
                lines.push(fragment);
              }
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
    for (const ch of '/systemprompt') {
      instance.stdin.write(ch);
      await new Promise(r => setTimeout(r, 20));
    }
    instance.stdin.write('\r');
    await new Promise(r => setTimeout(r, 100));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('You are a test agent.');
  });
});
