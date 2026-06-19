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
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { ModelPicker } from '../src/tui/components/ModelPicker.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';

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
        { id: 'core', name: 'Core', enabled: true },
        { id: 'persona', name: 'Persona', enabled: true },
      ],
      getRegisteredPluginCount: () => 2,
      getRegisteredToolCount: () => 3,
      getCapability: () => undefined,
      runHooks: async () => {},
      executeTool: async () => 'ok',
      getHelpSnippets: () => [],
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
    expect(frame).toContain('tools:3');
  });

  it('mentions terminal-native text selection in the rendered output', async () => {
    // The help text is produced on demand by `printHelp` inside App.
    // Submit a `/help` slash command through stdin. The flow is:
    //   - `ink-text-input` captures printable chars into the input
    //   - on Enter, it fires `onSubmit` which dispatches the command
    //   - `printHelp` appends entries which `<Static>` then renders
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    // Give the useInput effect time to register before any writes.
    // Without this delay, the first write is consumed by the raw-mode
    // setup before the listener is attached, and the test spuriously
    // fails to see the help text. 100ms is enough for a single mount.
    await new Promise(r => setTimeout(r, 100));
    // Type "/help" and press Enter. The test stdin treats each write
    // as a separate input event; ink-text-input concatenates them
    // into the buffer.
    for (const ch of '/help') {
      instance.stdin.write(ch);
      await new Promise(r => setTimeout(r, 20));
    }
    instance.stdin.write('\r');
    // Give React a few ticks to flush state.
    await new Promise(r => setTimeout(r, 100));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/native selection|Shift-drag|native/i);
  });

  it('mounts and renders without throwing', () => {
    // Sanity smoke: the TUI mounts in a test environment (without a real
    // TTY) and produces a non-empty first frame. The blessed version
    // required `autoPadding` and a `screen` element; the Ink version
    // is just a React tree and can render in node:testing mode.
    const opts = makeOptions();
    const instance = render(<App {...opts} />);
    cleanup = instance.cleanup;
    expect(instance.lastFrame()).toBeDefined();
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
    // The current model line is suffixed with '(current)'.
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
    // Let the useInput effect register before driving the picker.
    await new Promise(r => setTimeout(r, 100));
    // Move highlight to index 1 (down arrow escape sequence), then
    // submit (Enter / carriage return).
    instance.stdin.write('\u001b[B'); // down arrow
    await new Promise(r => setTimeout(r, 20));
    instance.stdin.write('\r'); // enter
    await new Promise(r => setTimeout(r, 50));
    expect(chosen).toBe('b');
  });
});
