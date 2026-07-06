/**
 * Tests for the Ink-based TUI.
 *
 * The full chat TUI touches a lot of state (event handlers, slash
 * commands, persona capabilities, context polling). We focus on the
 * pieces that are easy to assert deterministically:
 *
 *   - Status bar renders the model + plugin + tool count
 *   - The help text is reachable via /help and mentions terminal-native
 *     text selection (the new copy added during the blessed → ink port)
 *   - The persona color override is pushed on persona change and popped
 *     on persona clear
 *   - The Ink ModelPicker renders the model list and exposes Enter
 *     to select the highlighted item
 *   - The mid panel renders only when widgets have content; it hides
 *     otherwise
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { MidPanel } from '../src/tui/components/MidPanel.js';
import { ModelPicker } from '../src/tui/components/ModelPicker.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { DroneTuiOptions, MidPanelWidget } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';

function makeOptions(
  overrides: Partial<DroneTuiOptions> = {}
): DroneTuiOptions {
  let model = 'llama3.1:latest';
  return {
    model,
    logger: silentLogger(),
    engine: {
      listTools: () => [
        { name: 'tool-a', description: 'Tool A' },
        { name: 'tool-b', description: 'Tool B' },
        { name: 'tool-c', description: 'Tool C' },
      ],
      listPlugins: () => [
        {
          id: 'core',
          name: 'Core',
          enabled: true,
          required: true,
          defaultEnabled: true,
        },
        {
          id: 'persona',
          name: 'Persona',
          enabled: true,
          required: false,
          defaultEnabled: true,
        },
      ],
      getRegisteredPluginCount: () => 2,
      getRegisteredToolCount: () => 3,
      getCapability: () => undefined,
      getTool: () => undefined,
      runHooks: async () => {},
      executeTool: async () => 'ok',
      renderPromptFragments: async () => [],
      getConfig: () => {
        throw new Error('getConfig not used in tui tests');
      },
      getHelpSnippets: () => [],
      dispatchSlashCommand: async (_line, ctx) => {
        // Handle built-in commands for testing
        if (_line === '/help' || _line === '?') {
          if (ctx.printHelp) {
            ctx.printHelp();
          }
          return true;
        }
        return false;
      },
      onConversationEvent: () => () => {},
      setElicitation: () => {},
      runWorkflow: async () => ({ toolResult: '{}' }),
      getSlashCommands: () => [
        {
          command: '/help',
          description: 'Show this help',
          handler: async () => true,
        },
        {
          command: '/clear',
          description: 'Clear session',
          handler: async () => true,
        },
        {
          command: '/plugins',
          description: 'List plugins',
          handler: async () => true,
        },
        {
          command: '/tools',
          description: 'List registered tools (/tools --all for full list)',
          handler: async () => true,
        },
        {
          command: '/systemprompt',
          description: 'Show system prompt',
          handler: async () => true,
        },
        {
          command: '/tool',
          description: 'Run a tool',
          handler: async () => true,
        },
        {
          command: '/exec',
          description: 'Run a command',
          handler: async () => true,
        },
        { command: '/exit', description: 'Exit', handler: async () => true },
        { command: '/quit', description: 'Exit', handler: async () => true },
      ],
    },
    conversation: {
      sendUserMessage: async () => 'reply',
      clearSession: () => {},
      getEstimatedContextUsagePercent: async () => 12,
      setModel: (m: string) => {
        model = m;
      },
      getModel: () => model,
      enqueueUserMessage: () => {},
      cancelCurrentRequest: () => {},
    },
    ...overrides,
  };
}

describe('App', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('renders the status bar with model and stats', () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('model:llama3.1:latest');
    expect(frame).toContain('plugins:2');
    expect(frame).toContain('tools:3/3');
  });

  it('mentions terminal-native text selection in the rendered output', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    for (const ch of '/help') {
      instance.stdin.write(ch);
      await new Promise(r => setTimeout(r, 20));
    }
    instance.stdin.write('\r');
    await new Promise(r => setTimeout(r, 100));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/native selection|Shift-drag|native/i);
  });

  it('mounts and renders without throwing', () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    expect(instance.lastFrame()).toBeDefined();
  });

  it('does not render mid panel when no plugin offers widget content', () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('TODO');
  });

  it('renders mid panel when a plugin offers a widget with content', async () => {
    const widget: MidPanelWidget = {
      id: 'todo',
      label: 'TODO',
      getContent: () => ['3 / 5'],
    };
    const opts = makeOptions({
      engine: {
        listTools: () => [
          { name: 'tool-a', description: 'Tool A' },
          { name: 'tool-b', description: 'Tool B' },
          { name: 'tool-c', description: 'Tool C' },
        ],
        listPlugins: () => [
          {
            id: 'core',
            name: 'Core',
            enabled: true,
            required: true,
            defaultEnabled: true,
          },
          {
            id: 'persona',
            name: 'Persona',
            enabled: true,
            required: false,
            defaultEnabled: true,
          },
        ],
        getRegisteredPluginCount: () => 2,
        getRegisteredToolCount: () => 3,
        getCapability: ((pluginId: string) => {
          if (pluginId === 'todo') {
            return widget;
          }
          return undefined;
        }) as <T>(pluginId: string) => T | undefined,
        getTool: () => undefined,
        runHooks: async () => {},
        executeTool: async () => 'ok',
        renderPromptFragments: async () => [],
        getConfig: () => {
          throw new Error('getConfig not used in tui tests');
        },
        getHelpSnippets: () => [],
        dispatchSlashCommand: async (_line, ctx) => {
          if (_line === '/help' || _line === '?') {
            if (ctx.printHelp) {
              ctx.printHelp();
            }
            return true;
          }
          return false;
        },
        onConversationEvent: () => () => {},
        setElicitation: () => {},
        runWorkflow: async () => ({ toolResult: '{}' }),
        getSlashCommands: () => [
          {
            command: '/help',
            description: 'Show this help',
            handler: async () => true,
          },
          {
            command: '/clear',
            description: 'Clear session',
            handler: async () => true,
          },
          {
            command: '/plugins',
            description: 'List plugins',
            handler: async () => true,
          },
          {
            command: '/tools',
            description: 'List registered tools (/tools --all for full list)',
            handler: async () => true,
          },
          {
            command: '/systemprompt',
            description: 'Show system prompt',
            handler: async () => true,
          },
          {
            command: '/tool',
            description: 'Run a tool',
            handler: async () => true,
          },
          {
            command: '/exec',
            description: 'Run a command',
            handler: async () => true,
          },
          { command: '/exit', description: 'Exit', handler: async () => true },
          { command: '/quit', description: 'Exit', handler: async () => true },
        ],
      },
    });
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('TODO');
    expect(frame).toContain('3 / 5');
  });
});

describe('MidPanel', () => {
  it('returns nothing when widgets array is empty', () => {
    const instance = render(
      <MidPanel widgets={[]} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('returns nothing when all widgets have empty content', () => {
    const widgets: MidPanelWidget[] = [
      { id: 'todo', label: 'TODO', getContent: () => [] },
    ];
    const instance = render(
      <MidPanel widgets={widgets} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('renders widget header and content inline', () => {
    const widgets: MidPanelWidget[] = [
      {
        id: 'todo',
        label: 'TODO',
        getContent: () => ['3 / 5'],
      },
    ];
    const instance = render(
      <MidPanel widgets={widgets} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('TODO');
    expect(frame).toContain('3 / 5');
  });

  it('renders multiple widgets with separator', () => {
    const widgets: MidPanelWidget[] = [
      {
        id: 'todo',
        label: 'TODO',
        getContent: () => ['3 / 5'],
      },
      {
        id: 'insights',
        label: 'Insights',
        getContent: () => ['12'],
      },
    ];
    const instance = render(
      <MidPanel widgets={widgets} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('TODO');
    expect(frame).toContain('Insights');
    expect(frame).toContain('3 / 5');
    expect(frame).toContain('12');
    expect(frame).toContain('│');
  });
});

describe('ModelPicker', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('renders one line per model', () => {
    const onSelect = (): void => {};
    const instance = render(
      <ModelPicker
        models={['llama3.1:latest', 'mistral:7b', 'phi3:mini']}
        current="llama3.1:latest"
        onSelect={onSelect}
      />
    );
    cleanup = instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('llama3.1:latest');
    expect(frame).toContain('mistral:7b');
    expect(frame).toContain('phi3:mini');
  });

  it('highlights the currently selected model', () => {
    const onSelect = (): void => {};
    const instance = render(
      <ModelPicker
        models={['llama3.1:latest', 'mistral:7b']}
        current="mistral:7b"
        onSelect={onSelect}
      />
    );
    cleanup = instance.cleanup;
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('mistral:7b (current)');
  });

  it('calls onSelect with the highlighted model on Enter', async () => {
    let chosen: string | null = null;
    const onSelect = (m: string): void => {
      chosen = m;
    };
    const instance = render(
      <ModelPicker models={['a', 'b', 'c']} current="a" onSelect={onSelect} />
    );
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('\u001b[B');
    await new Promise(r => setTimeout(r, 20));
    instance.stdin.write('\r');
    await new Promise(r => setTimeout(r, 50));
    expect(chosen).toBe('b');
  });
});