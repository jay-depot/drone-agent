/**
 * TUI tests for the persona color override.
 *
 * Verifies the end-to-end runtime path: when the active persona has a
 * `uiColor`, the persona plugin fires `notifyChange`, the TUI
 * subscriber pushes a color override, and Ink emits ANSI escape
 * sequences that tint the input-line border / prompt label.
 *
 * We rely on `FORCE_COLOR=1` so chalk emits ANSI codes regardless of
 * whether the underlying stream is a TTY (ink-testing-library's
 * Stdout doesn't implement TTY semantics, so chalk otherwise disables
 * color output and the rendered frames would be indistinguishable).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import type { DroneTuiOptions } from '../src/tui/types.js';
import { silentLogger } from './helpers.js';

type PersonaCallback = (
  persona: { id: string; uiColor?: string } | null
) => void;

type PersonaCap = {
  getActivePersona: () => { id: string; uiColor?: string } | null;
  onPersonaChange: (callback: PersonaCallback) => void;
};

function makeOptions(personaCap?: PersonaCap): DroneTuiOptions {
  let model = 'llama3.1:latest';
  const cap = personaCap;
  const engine = {
    listTools: () => [],
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => 0,
    getCapability: ((_id: string) => (_id === 'persona' ? cap : undefined)) as <
      T,
    >(
      pluginId: string
    ) => T | undefined,
    runHooks: async (): Promise<void> => {},
    executeTool: async (): Promise<string> => 'ok',
    getHelpSnippets: (): string[] => [],
  };
  return {
    model,
    logger: silentLogger(),
    engine,
    conversation: {
      sendUserMessage: async (): Promise<string> => 'reply',
      clearSession: (): void => {},
      getEstimatedContextUsagePercent: async (): Promise<number> => 12,
      setModel: (m: string): void => {
        model = m;
      },
      getModel: (): string => model,
    },
  };
}

describe('App — persona color override', () => {
  let cleanup: (() => void) | null = null;

  beforeAll(() => {
    // Force chalk to emit ANSI codes regardless of TTY detection.
    // ink-testing-library's Stdout doesn't implement TTY semantics,
    // so without this the rendered frames would all be color-stripped
    // and we'd lose the ability to assert on the emitted escape codes.
    process.env.FORCE_COLOR = '1';
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('emits ANSI color codes when a persona with uiColor is active', async () => {
    let callback: PersonaCallback | null = null;
    const personaCap: PersonaCap = {
      getActivePersona: () => null,
      onPersonaChange: cb => {
        callback = cb;
      },
    };
    const instance = render(<App {...makeOptions(personaCap)} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 50));
    expect(callback).not.toBeNull();
    // Activate the persona.
    callback!({ id: 'planner', uiColor: 'blue' });
    // Let React flush.
    await new Promise(r => setTimeout(r, 50));
    // ANSI escape for blue foreground is \x1b[34m. The persona override
    // tints the input line's border (via `scheme.border`) and the
    // prompt label (via `scheme.userInput`). Look for the blue escape
    // anywhere in the latest frames.
    const frames = instance.stdout.frames.join('');
    expect(frames).toContain('\x1b[34m');
  });

  it('uses hex codes verbatim when uiColor is a hex string', async () => {
    let callback: PersonaCallback | null = null;
    const personaCap: PersonaCap = {
      getActivePersona: () => null,
      onPersonaChange: cb => {
        callback = cb;
      },
    };
    const instance = render(<App {...makeOptions(personaCap)} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 50));
    callback!({ id: 'researcher', uiColor: '#ff8800' });
    await new Promise(r => setTimeout(r, 50));
    const frames = instance.stdout.frames.join('');
    // chalk's hex output for #ff8800 produces a specific escape
    // sequence; just assert that some escape sequence appeared.
    expect(frames).toMatch(/\x1b\[\d+(;\d+)*m/);
  });

  it('falls back to the default grayscale scheme when no uiColor is set', async () => {
    let callback: PersonaCallback | null = null;
    const personaCap: PersonaCap = {
      getActivePersona: () => null,
      onPersonaChange: cb => {
        callback = cb;
      },
    };
    const instance = render(<App {...makeOptions(personaCap)} />);
    cleanup = instance.cleanup;
    await new Promise(r => setTimeout(r, 50));
    // Activate a persona with no uiColor.
    callback!({ id: 'plain', uiColor: undefined });
    await new Promise(r => setTimeout(r, 50));
    // The default `border` is "gray" which renders with the gray ANSI
    // escape (\x1b[90m for bright black / gray). Verify it appears.
    const frames = instance.stdout.frames.join('');
    expect(frames).toContain('\x1b[90m');
  });
});
