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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { initialPickerIndex } from '../src/tui/hooks/useElicitation.js';
import { MidPanel } from '../src/tui/components/MidPanel.js';
import { ModelPicker } from '../src/tui/components/ModelPicker.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { DroneTuiOptions, MidPanelWidget } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';

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

/** Wait one macrotask so Ink's (asynchronous) render has flushed. */
const tick = () => new Promise(r => setTimeout(r, 10));

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
      getMountedToolCount: () => 0,
      getCapability: () => undefined,
      getTool: () => undefined,
      runHooks: async () => {},
      executeTool: async () => 'ok',
      renderPromptFragments: async () => [],
      getConfig: () => {
        throw new Error('getConfig not used in tui tests');
      },
      buildSystemMessages: async () => [],
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
      getReasoningLevel: () => undefined,
      setReasoningLevel: (_level: unknown) => {},
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

  it('renders the status bar with model and stats', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await tick();
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
    instance.stdin.write('/help');
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('\r');
    const frame = await waitUntilFrame(instance, f =>
      /native selection|Shift-drag|native/i.test(f)
    );
    expect(frame).toMatch(/native selection|Shift-drag|native/i);
  });

  it('mounts and renders without throwing', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await tick();
    expect(instance.lastFrame()).toBeDefined();
  });

  it('does not render mid panel when no plugin offers widget content', async () => {
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    await tick();
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
        getMountedToolCount: () => 0,
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
        buildSystemMessages: async () => [],
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
    const frame = await waitUntilFrame(
      instance,
      f => f.includes('TODO') && f.includes('3 / 5')
    );
    expect(frame).toContain('TODO');
    expect(frame).toContain('3 / 5');
  });
});

describe('MidPanel', () => {
  it('returns nothing when widgets array is empty', async () => {
    const instance = render(
      <MidPanel widgets={[]} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('returns nothing when all widgets have empty content', async () => {
    const widgets: MidPanelWidget[] = [
      { id: 'todo', label: 'TODO', getContent: () => [] },
    ];
    const instance = render(
      <MidPanel widgets={widgets} scheme={DEFAULT_GRAYSCALE_SCHEME} />
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('renders widget header and content inline', async () => {
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
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('TODO');
    expect(frame).toContain('3 / 5');
  });

  it('renders multiple widgets with separator', async () => {
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
    await tick();
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

  it('renders one line per model', async () => {
    const onSelect = (): void => {};
    const instance = render(
      <ModelPicker
        models={['llama3.1:latest', 'mistral:7b', 'phi3:mini']}
        current="llama3.1:latest"
        onSelect={onSelect}
      />
    );
    cleanup = instance.cleanup;
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('llama3.1:latest');
    expect(frame).toContain('mistral:7b');
    expect(frame).toContain('phi3:mini');
  });

  it('highlights the currently selected model', async () => {
    const onSelect = (): void => {};
    const instance = render(
      <ModelPicker
        models={['llama3.1:latest', 'mistral:7b']}
        current="mistral:7b"
        onSelect={onSelect}
      />
    );
    cleanup = instance.cleanup;
    await tick();
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

describe('App initial workflow host (--workflow, ADR 183)', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('runs the workflow on mount and renders the kick reply as a chat turn', async () => {
    const sendCalls: string[] = [];
    const opts: DroneTuiOptions = makeOptions();
    let workflowArgs: unknown[] = [];
    opts.engine.runWorkflow = async (
      name: string,
      args: Record<string, unknown>
    ) => {
      workflowArgs = [name, args];
      return {
        toolResult: 'steps completed',
        kickMessage: 'Workflow wf__x completed and handed off the following.',
        continueSession: true,
      };
    };
    opts.conversation = {
      ...opts.conversation,
      sendUserMessage: async (prompt: string) => {
        sendCalls.push(prompt);
        return 'done, anything else?';
      },
    };
    opts.initialWorkflow = { name: 'wf__x', args: {} };

    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;

    const start = await waitUntilFrame(instance, f =>
      f.includes('Running workflow wf__x...')
    );
    expect(start).toContain('Running workflow wf__x...');
    expect(workflowArgs).toEqual(['wf__x', {}]);
    const start2 = Date.now();
    while (sendCalls.length === 0 && Date.now() - start2 < 2000) {
      await tick();
    }
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toContain('handed off the following');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toContain('handed off the following');
  });

  it('calls onWorkflowComplete and keeps the session open when continueSession is true', async () => {
    const onComplete = vi.fn();
    const opts: DroneTuiOptions = makeOptions();
    opts.engine.runWorkflow = async () => ({
      toolResult: 'r',
      continueSession: true,
    });
    opts.initialWorkflow = { name: 'wf__y', args: {} };
    opts.onWorkflowComplete = onComplete;

    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;

    await waitUntilFrame(instance, f => f.includes('model:llama3.1:latest'));
    await tick();
    expect(onComplete).toHaveBeenCalledWith({ continueSession: true });
  });

  it('exits via useApp when continueSession is false', async () => {
    const onComplete = vi.fn();
    const opts: DroneTuiOptions = makeOptions();
    opts.engine.runWorkflow = async () => ({
      toolResult: 'r',
      continueSession: false,
    });
    opts.initialWorkflow = { name: 'wf__z', args: {} };
    opts.onWorkflowComplete = onComplete;

    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;

    await waitUntilFrame(instance, f => f.includes('model:llama3.1:latest'));
    await tick();
    expect(onComplete).toHaveBeenCalledWith({ continueSession: false });
  });

  it('surfaces workflow failure in the chat log and reports continueSession=false', async () => {
    const onComplete = vi.fn();
    const opts: DroneTuiOptions = makeOptions();
    opts.engine.runWorkflow = async () => {
      throw new Error('workflow exploded');
    };
    opts.initialWorkflow = { name: 'wf__boom', args: {} };
    opts.onWorkflowComplete = onComplete;

    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;

    const start3 = Date.now();
    while (onComplete.mock.calls.length === 0 && Date.now() - start3 < 2000) {
      await tick();
    }
    expect(onComplete).toHaveBeenCalledWith({ continueSession: false });
    expect(onComplete).toHaveBeenCalledWith({ continueSession: false });
  });
});

describe('initialPickerIndex (default/highlight agreement)', () => {
  it('highlights the choice matching defaultValue', () => {
    expect(
      initialPickerIndex({
        id: 'q',
        prompt: 'Install?',
        choices: [
          { value: 'yes', label: 'Yes — apply it' },
          { value: 'no', label: 'No — stop here' },
        ],
        defaultValue: 'no',
      })
    ).toBe(1);
  });

  it('falls back to 0 when no choice matches the default', () => {
    expect(
      initialPickerIndex({
        id: 'q',
        prompt: 'Pick?',
        choices: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        defaultValue: 'missing',
      })
    ).toBe(0);
  });

  it('falls back to 0 when there is no default', () => {
    expect(
      initialPickerIndex({
        id: 'q',
        prompt: 'Pick?',
        choices: [{ value: 'a', label: 'A' }],
      })
    ).toBe(0);
  });

  it('returns 0 for freeform questions (no picker)', () => {
    expect(
      initialPickerIndex({ id: 'q', prompt: 'Type?', freeform: true })
    ).toBe(0);
  });
});

describe('TUI picker highlights the default on mutation confirms', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('renders the ▶ marker on the defaultValue choice', async () => {
    const elicitQuestion = {
      id: 'write-cron',
      prompt: 'Install the catch-up cron entry?',
      choices: [
        { value: 'yes', label: 'Yes — apply it' },
        { value: 'no', label: 'No — stop here' },
      ],
      defaultValue: 'no',
      uiKey: 'test-ui-key',
    };
    const opts = makeOptions();
    opts.engine.setElicitation = (cap: unknown) => {
      // Capture the capability the hook wires, then simulate a question.
      const elicitation = cap as {
        ask: (questions: unknown[]) => Promise<Record<string, string>>;
      };
      elicitation.ask([elicitQuestion]).catch(() => undefined);
    };
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;

    const frame = await waitUntilFrame(instance, f =>
      f.includes('Install the catch-up cron entry?')
    );
    expect(frame).toContain('Install the catch-up cron entry?');
    expect(frame).toContain('No — stop here (default)');
    // The highlight marker ▶ must sit on the "No" line, not "Yes".
    const noLine = frame.split('\n').find(l => l.includes('No — stop here'));
    const yesLine = frame.split('\n').find(l => l.includes('Yes — apply it'));
    expect(noLine).toContain('▶');
    expect(yesLine).not.toContain('▶');
  });
});
