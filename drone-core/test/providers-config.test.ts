import { describe, expect, it } from 'vitest';
import {
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  parseConfigWithSchema,
  validateProviders,
} from '../src/index.js';
import type { DroneProviderConfig } from '../src/index.js';

describe('providers config schema', () => {
  it('accepts a valid providers section', () => {
    const parsed = parseConfigWithSchema(
      {
        providers: {
          local: {
            protocol: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            models: {
              'llama3.1': { contextWindow: 131072 },
              fast: { model: 'llama3.1', parameters: { numCtx: 8192 } },
            },
          },
          cloud: {
            protocol: 'openrouter',
            apiKey: 'sk-or-test',
            autoImport: 'all',
          },
        },
      },
      'test'
    );
    const providers = parsed.providers ?? {};
    expect(providers['local']?.protocol).toBe('ollama');
    expect(providers['local']?.models?.['fast']?.model).toBe('llama3.1');
    expect(providers['cloud']?.autoImport).toBe('all');
  });

  it('rejects an entry missing protocol', () => {
    expect(() =>
      parseConfigWithSchema(
        { providers: { bad: { baseUrl: 'http://x' } } },
        'test'
      )
    ).toThrow(/protocol/);
  });

  it('rejects invalid autoImport values', () => {
    expect(() =>
      parseConfigWithSchema(
        { providers: { p: { protocol: 'ollama', autoImport: 'sometimes' } } },
        'test'
      )
    ).toThrow();
  });

  it('rejects invalid llm.active (must be provider/model)', () => {
    expect(() =>
      parseConfigWithSchema({ llm: { active: 'justamodel' } }, 'test')
    ).toThrow();
    const ok = parseConfigWithSchema(
      { llm: { active: 'openrouter/anthropic/claude-opus-4.8' } },
      'test'
    );
    expect(ok.llm?.active).toBe('openrouter/anthropic/claude-opus-4.8');
  });

  it('keeps parameter values untyped at the structural layer', () => {
    // Value-type checking happens against each driver's parameterSchema,
    // not the structural config schema (unknown keys are warn-but-send).
    const parsed = parseConfigWithSchema(
      {
        providers: {
          p: {
            protocol: 'ollama',
            models: { m: { parameters: { temperature: 'hot' } } },
          },
        },
      },
      'test'
    );
    const typed = parsed.providers ?? {};
    expect(typed['p']?.models?.['m']?.parameters).toEqual({
      temperature: 'hot',
    });
  });
});

describe('validateProviders semantic rules', () => {
  it('errors on slashful provider ids', () => {
    const result = validateProviders({
      'bad/id': { protocol: 'ollama' },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('slash-free');
  });

  it('errors on missing protocol', () => {
    const result = validateProviders({
      p: {} as DroneProviderConfig,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('protocol');
  });

  it('warns on self-alias', () => {
    const result = validateProviders({
      p: { protocol: 'ollama', models: { m: { model: 'm' } } },
    });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('aliases itself');
  });

  it('warns on alias chains', () => {
    const result = validateProviders({
      p: {
        protocol: 'ollama',
        models: {
          a: { model: 'b' },
          b: { model: 'upstream' },
        },
      },
    });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Alias chain');
  });

  it('accepts a one-level alias and upstream ids silently', () => {
    const result = validateProviders({
      p: {
        protocol: 'ollama',
        models: {
          fast: { model: 'llama3.1:70b' },
          llama3: { model: 'llama3.1:70b' },
        },
      },
    });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('providers merge semantics', () => {
  it('merges by key but replaces whole entries', () => {
    const base = createDefaultAgentConfig();
    const withProvider = applyAgentConfigLayer(base, {
      providers: {
        main: {
          protocol: 'ollama',
          baseUrl: 'http://beacon:11434',
          parameters: { temperature: 0.7 },
          models: { llama: { contextWindow: 8192 } },
        },
      },
    });
    // Project scope redefines the same provider id with different fields —
    // the whole entry is replaced, NOT deep-merged.
    const withOverride = applyAgentConfigLayer(withProvider, {
      providers: {
        main: {
          protocol: 'openai',
          baseUrl: 'https://api.local/v1',
        },
      },
    });
    expect(withOverride.providers['main']?.protocol).toBe('openai');
    expect(withOverride.providers['main']?.parameters).toBeUndefined();
    expect(withOverride.providers['main']?.models).toBeUndefined();
    expect(withOverride.providers['main']?.baseUrl).toBe(
      'https://api.local/v1'
    );
  });

  it('keeps distinct provider entries from multiple scopes', () => {
    const base = createDefaultAgentConfig();
    const merged = applyAgentConfigLayer(base, {
      providers: {
        a: { protocol: 'ollama' },
      },
    });
    const merged2 = applyAgentConfigLayer(merged, {
      providers: {
        b: { protocol: 'anthropic' },
      },
    });
    expect(Object.keys(merged2.providers).sort()).toEqual(['a', 'b']);
  });

  it('defaults providers to an empty map and llm has no active', () => {
    const config = createDefaultAgentConfig();
    expect(config.providers).toEqual({});
    expect(config.llm.active).toBeUndefined();
    expect(config.llm.provider).toBe('ollama');
  });
});
