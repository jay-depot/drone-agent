import { describe, expect, it, vi } from 'vitest';
import {
  BeaconConfigInjector,
  normalizeFlatUnderlay,
} from '../../src/plugins/swarm/config.js';

describe('normalizeFlatUnderlay', () => {
  it('nests flat dotted keys into a partial config shape', () => {
    const { config, skippedKeys } = normalizeFlatUnderlay({
      'llm.active': 'swarm/model',
      'providers.openrouter': {
        protocol: 'openrouter',
        apiKey: '${SWARM_KEY}',
      },
      'compaction.enabled': false,
    });

    expect(skippedKeys).toEqual([]);
    expect(config).toEqual({
      llm: { active: 'swarm/model' },
      providers: {
        openrouter: { protocol: 'openrouter', apiKey: '${SWARM_KEY}' },
      },
      compaction: { enabled: false },
    });
  });

  it('nests multi-segment guardrail keys and skips keys outside the underlay allowlist', () => {
    const { config, skippedKeys } = normalizeFlatUnderlay({
      'session.guardrail.identicalToolCalls.maxHints': 3,
      'llm.active': 'swarm/model',
      systemPrompt: 'not distributable',
      'mcp.enabled': true,
    });

    expect(skippedKeys).toEqual(['systemPrompt', 'mcp.enabled']);
    expect(config).toEqual({
      session: { guardrail: { identicalToolCalls: { maxHints: 3 } } },
      llm: { active: 'swarm/model' },
    });
  });
});

describe('BeaconConfigInjector.inject', () => {
  it('fetches the beacon merged config, nests flat keys, and preserves ${VAR} templates', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'llm.active', value: '"swarm/model"' },
          {
            key: 'providers.openrouter',
            value: '{"protocol":"openrouter","apiKey":"${SWARM_KEY}"}',
          },
        ]),
        { status: 200 }
      )
    );
    const injector = new BeaconConfigInjector('http://localhost:3457');

    const result = await injector.inject();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3457/config');
    expect(result).toEqual({
      llm: { active: 'swarm/model' },
      providers: {
        openrouter: { protocol: 'openrouter', apiKey: '${SWARM_KEY}' },
      },
    });
    vi.restoreAllMocks();
  });

  it('skips malformed JSON values with a one-time warning', async () => {
    const warnings: string[] = [];
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'llm.active', value: '"swarm/model"' },
          { key: 'providers.broken', value: '{not json' },
        ]),
        { status: 200 }
      )
    );
    const injector = new BeaconConfigInjector(
      'http://localhost:3457',
      (message: string) => warnings.push(message)
    );

    const first = await injector.inject();
    expect(first).toEqual({ llm: { active: 'swarm/model' } });
    expect(warnings.some(w => w.includes('providers.broken'))).toBe(true);

    const warningCount = warnings.length;
    const second = await injector.inject();
    expect(second).toEqual(first);
    expect(warnings.length).toBe(warningCount);
    vi.restoreAllMocks();
  });

  it('returns the cached config when the beacon is unreachable', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ key: 'llm.active', value: '"a/b"' }]), {
          status: 200,
        })
      )
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const injector = new BeaconConfigInjector('http://localhost:3457');

    const warm = await injector.inject();
    expect(warm).toEqual({ llm: { active: 'a/b' } });

    const cached = await injector.inject();
    expect(cached).toEqual(warm);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
