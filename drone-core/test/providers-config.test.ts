import { describe, expect, it } from 'vitest';
import {
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  parseConfigWithSchema,
  validateModelRoles,
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

  it('accepts session.retry overrides', () => {
    const parsed = parseConfigWithSchema(
      {
        session: {
          retry: {
            maxRetries: 5,
            maxWaitMs: 60000,
            promptOnError: false,
            backoffBaseMs: 500,
            backoffFactor: 3,
          },
        },
      },
      'test'
    );
    expect(parsed.session?.retry).toEqual({
      maxRetries: 5,
      maxWaitMs: 60000,
      promptOnError: false,
      backoffBaseMs: 500,
      backoffFactor: 3,
    });
  });

  it('rejects non-numeric session.retry.maxRetries', () => {
    expect(() =>
      parseConfigWithSchema(
        { session: { retry: { maxRetries: 'lots' } } },
        'test'
      )
    ).toThrow();
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

describe('llm.modelRoles', () => {
  it('accepts full-form role values in the schema', () => {
    const parsed = parseConfigWithSchema(
      {
        llm: {
          modelRoles: {
            summarizer: 'ollama/llama3.1',
            wizard: 'anthropic/claude-haiku-4-5',
          },
        },
      },
      'test'
    );
    expect(parsed.llm?.modelRoles?.['summarizer']).toBe('ollama/llama3.1');
  });

  it('rejects bare (slash-less) role values', () => {
    expect(() =>
      parseConfigWithSchema(
        { llm: { modelRoles: { summarizer: 'justamodel' } } },
        'test'
      )
    ).toThrow();
  });

  it('merges modelRoles per-key across layers', () => {
    const base = createDefaultAgentConfig();
    const user = applyAgentConfigLayer(base, {
      llm: { modelRoles: { summarizer: 'ollama/llama3.1' } },
    });
    const withSwarm = applyAgentConfigLayer(user, {
      llm: { modelRoles: { wizard: 'anthropic/claude-haiku-4-5' } },
    });
    expect(withSwarm.llm.modelRoles).toEqual({
      summarizer: 'ollama/llama3.1',
      wizard: 'anthropic/claude-haiku-4-5',
    });
  });
});

describe('validateModelRoles', () => {
  it('returns no warnings when roles are well-known and providers exist', () => {
    const providers = {
      ollama: { protocol: 'ollama' } as DroneProviderConfig,
    };
    expect(
      validateModelRoles(providers, { summarizer: 'ollama/llama3.1' })
    ).toEqual([]);
  });

  it('warns on a role name outside the well-known list', () => {
    const warnings = validateModelRoles(
      { ollama: { protocol: 'ollama' } },
      { 'typo-role': 'ollama/llama3.1' }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not a well-known role');
  });

  it('warns when a role references a provider with no entry', () => {
    const warnings = validateModelRoles(
      {},
      { summarizer: 'missing-provider/llama3.1' }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing-provider');
  });

  it('handles undefined modelRoles as no-op', () => {
    expect(validateModelRoles({}, undefined)).toEqual([]);
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
