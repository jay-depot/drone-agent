import { describe, expect, it } from 'vitest';
import {
  WELL_KNOWN_MODEL_ROLES,
  formatModelSelection,
  isValidFullModelSelection,
  parseModelSelection,
  resolveConfiguredReasoningLevel,
  resolveInteractiveSelection,
} from '../src/model-selection.js';
import type { DroneAgentConfig } from '../src/config-types.js';

describe('parseModelSelection', () => {
  it('splits on the first slash (OpenRouter-style multi-slash ids)', () => {
    expect(parseModelSelection('openrouter/anthropic/claude-opus-4.8')).toEqual(
      {
        providerId: 'openrouter',
        modelLocalId: 'anthropic/claude-opus-4.8',
      }
    );
  });

  it('parses simple provider/model pairs', () => {
    expect(parseModelSelection('ollama/llama3.1')).toEqual({
      providerId: 'ollama',
      modelLocalId: 'llama3.1',
    });
  });

  it('rejects bare ids', () => {
    expect(parseModelSelection('llama3.1')).toBeUndefined();
  });

  it('rejects leading slash', () => {
    expect(parseModelSelection('/llama3.1')).toBeUndefined();
  });

  it('rejects trailing slash', () => {
    expect(parseModelSelection('ollama/')).toBeUndefined();
  });
});

describe('formatModelSelection + round-trip', () => {
  it('formats back to the canonical string', () => {
    const selection = { providerId: 'p', modelLocalId: 'a/b/c' };
    const formatted = formatModelSelection(selection);
    expect(formatted).toBe('p/a/b/c');
    expect(parseModelSelection(formatted)).toEqual(selection);
  });
});

describe('isValidFullModelSelection', () => {
  it('accepts full forms and rejects bare ids', () => {
    expect(isValidFullModelSelection('ollama/llama3.1')).toBe(true);
    expect(isValidFullModelSelection('llama3.1')).toBe(false);
    expect(isValidFullModelSelection('/x')).toBe(false);
    expect(isValidFullModelSelection('x/')).toBe(false);
  });
});

describe('resolveInteractiveSelection', () => {
  it('passes full selections through unchanged', () => {
    expect(resolveInteractiveSelection('openai/gpt-4o', 'ollama')).toEqual({
      full: 'openai/gpt-4o',
      selection: { providerId: 'openai', modelLocalId: 'gpt-4o' },
    });
  });

  it('resolves bare ids against the active provider', () => {
    expect(resolveInteractiveSelection('llama3.1', 'ollama')).toEqual({
      full: 'ollama/llama3.1',
      selection: { providerId: 'ollama', modelLocalId: 'llama3.1' },
    });
  });

  it('rejects a bare id with no active provider', () => {
    expect(resolveInteractiveSelection('llama3.1', '')).toBeUndefined();
  });
});

describe('WELL_KNOWN_MODEL_ROLES', () => {
  it('lists the built-in plugin roles', () => {
    expect([...WELL_KNOWN_MODEL_ROLES].sort()).toEqual([
      'describer',
      'summarizer',
      'wizard',
    ]);
  });
});

describe('resolveConfiguredReasoningLevel', () => {
  const base = (overrides?: Partial<DroneAgentConfig>): DroneAgentConfig =>
    ({
      providers: {},
      llm: { provider: 'ollama' },
      ...overrides,
    }) as DroneAgentConfig;

  it('falls back to llm.reasoningLevel when the model entry has none', () => {
    const config = base({ llm: { provider: 'ollama', reasoningLevel: 'low' } });
    expect(
      resolveConfiguredReasoningLevel(config, {
        providerId: 'ollama',
        modelLocalId: 'llama3.1',
      })
    ).toBe('low');
  });

  it('prefers the selected model entry reasoningLevel', () => {
    const config = base({
      providers: {
        p: {
          protocol: 'ollama',
          models: { m: { reasoningLevel: 'high' } },
        },
      },
      llm: { provider: 'ollama', reasoningLevel: 'low' },
    });
    expect(
      resolveConfiguredReasoningLevel(config, {
        providerId: 'p',
        modelLocalId: 'm',
      })
    ).toBe('high');
  });

  it('returns undefined when neither the entry nor llm config sets it', () => {
    const config = base();
    expect(
      resolveConfiguredReasoningLevel(config, {
        providerId: 'p',
        modelLocalId: 'm',
      })
    ).toBeUndefined();
  });
});
