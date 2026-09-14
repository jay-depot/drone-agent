import { describe, expect, it } from 'vitest';
import {
  buildDistributionEntries,
  resolveSecretRefs,
} from '../src/config-resolve.js';
import type { CoordinatorConfigEntry } from 'drone-core';

function entry(
  key: string,
  value: string,
  secret = false
): CoordinatorConfigEntry {
  return {
    key,
    value,
    secret,
    description: null,
    updatedAt: 1000,
  };
}

describe('resolveSecretRefs', () => {
  it('resolves every reference when all names exist (embedded ok)', () => {
    const result = resolveSecretRefs(
      '{"apiKey":"${secret:K1}","user":"${secret:U}"}',
      new Map([
        ['K1', 'sk-1111'],
        ['U', 'joe'],
      ])
    );
    expect(result).toEqual({
      ok: true,
      value: '{"apiKey":"sk-1111","user":"joe"}',
    });
  });

  it('returns ok with value unchanged when there are no refs', () => {
    const result = resolveSecretRefs('{"apiKey":"${ENV_VAR}"}', new Map());
    expect(result).toEqual({ ok: true, value: '{"apiKey":"${ENV_VAR}"}' });
  });

  it('reports all missing names', () => {
    const result = resolveSecretRefs('${secret:A}-${secret:B}', new Map());
    expect(result).toEqual({ ok: false, missing: ['A', 'B'] });
  });
});

describe('buildDistributionEntries', () => {
  const secrets = new Map<string, string>([
    ['KNOWN', 'real-secret-value'],
    ['OTHER', 'other-real-value'],
  ]);
  const getSecretValue = (name: string) => secrets.get(name);

  it('resolves embedded refs and flags the row containsSecrets', () => {
    const { entries, dropped } = buildDistributionEntries(
      [entry('providers.openai', '{"apiKey":"${secret:KNOWN}","org":"x"}')],
      getSecretValue
    );
    expect(dropped).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'providers.openai',
      value: '{"apiKey":"real-secret-value","org":"x"}',
      containsSecrets: true,
    });
  });

  it('drops only the row with missing refs; other rows distribute normally', () => {
    const { entries, dropped } = buildDistributionEntries(
      [
        entry('providers.ok', '{"apiKey":"${secret:KNOWN}"}'),
        entry('providers.broken', '{"apiKey":"${secret:MISSING}"}'),
        entry('llm.active', 'openai/main'),
      ],
      getSecretValue
    );
    expect(dropped).toEqual([
      { key: 'providers.broken', missing: ['MISSING'] },
    ]);
    expect(entries.map(e => e.key)).toEqual(['providers.ok', 'llm.active']);
  });

  it('leaves rows without refs untouched and flags legacy secret rows', () => {
    const { entries } = buildDistributionEntries(
      [
        entry('llm.active', 'openai/main'),
        entry('providers.legacy', '${OPENROUTER_ENV_VAR}', true),
      ],
      getSecretValue
    );
    expect(entries).toEqual([
      {
        ...entry('llm.active', 'openai/main'),
        containsSecrets: false,
      },
      {
        ...entry('providers.legacy', '${OPENROUTER_ENV_VAR}', true),
        containsSecrets: true,
      },
    ]);
  });

  it('does not invoke getSecretValue for rows without refs', () => {
    let calls = 0;
    buildDistributionEntries([entry('llm.active', 'x')], () => {
      calls += 1;
      return 'unused';
    });
    expect(calls).toBe(0);
  });
});
