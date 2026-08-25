import { describe, expect, it } from 'vitest';
import { createDefaultAgentConfig } from 'drone-core';
import { enforceProviderScopePolicy } from '../src/runtime/provider-scope-policy.js';
import { parseConfigWithSchema } from 'drone-core';
import type { DroneConfigLayer } from 'drone-core';

function projectLayer(
  config: Record<string, unknown>,
  path = '/proj/.drone-agent/config.json'
): DroneConfigLayer {
  return {
    scope: 'project',
    path,
    config: config as never,
  };
}

describe('provider scope policy', () => {
  it('errors when a project-scope file defines providers', () => {
    const result = enforceProviderScopePolicy([
      projectLayer({
        providers: { local: { protocol: 'ollama' } },
      }),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('banned at project scope');
    expect(result.errors[0]).toContain('local');
  });

  it('warns on project-scope plaintext apiKeys', () => {
    const result = enforceProviderScopePolicy([
      projectLayer({ openai: { apiKey: 'sk-literal' } }),
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('plaintext apiKey');
    expect(result.warnings[0]).toContain('openai');
  });

  it('does not warn on project-scope ${VAR} templates', () => {
    const result = enforceProviderScopePolicy([
      projectLayer({ anthropic: { apiKey: '${ANTHROPIC_API_KEY}' } }),
    ]);
    expect(result.warnings).toHaveLength(0);
  });

  it('ignores user-scope files entirely', () => {
    const result = enforceProviderScopePolicy([
      {
        scope: 'user',
        path: '/home/u/.drone-agent/config.json',
        config: {
          providers: { mine: { protocol: 'ollama' } },
          openai: { apiKey: 'sk-user-literal' },
        } as never,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('ignores legacy sections other than apiKey warnings (grandfathered)', () => {
    const result = enforceProviderScopePolicy([
      projectLayer({
        ollama: { host: 'http://x', model: 'm' },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
      }),
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('${VAR} interpolation of provider secrets', () => {
  it('interpolates resolved env vars in provider entries', () => {
    process.env.TEST_PROVIDER_KEY = 'sk-interpolated';
    try {
      const parsed = parseConfigWithSchema(
        {
          providers: {
            p: { protocol: 'openai', apiKey: '${TEST_PROVIDER_KEY}' },
          },
        },
        'test'
      );
      expect(parsed.providers?.['p']?.apiKey).toBe('sk-interpolated');
    } finally {
      delete process.env.TEST_PROVIDER_KEY;
    }
  });

  it('fails with var name + path when the variable is unset', () => {
    delete process.env.DEFINITELY_UNSET_VAR_123;
    expect(() =>
      parseConfigWithSchema(
        {
          providers: {
            p: { protocol: 'anthropic', apiKey: '${DEFINITELY_UNSET_VAR_123}' },
          },
        },
        'user-config'
      )
    ).toThrow(/providers\.p\.apiKey[\s\S]*DEFINITELY_UNSET_VAR_123/);
  });
});
