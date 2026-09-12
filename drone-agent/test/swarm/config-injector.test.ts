import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BeaconConfigInjector,
  normalizeFlatUnderlay,
  resolveEnvTemplates,
} from '../../src/plugins/swarm/config.js';

const TEST_ENV_KEY = 'DRONE_TEST_UNDERLAY_KEY';

describe('resolveEnvTemplates', () => {
  afterEach(() => {
    delete process.env[TEST_ENV_KEY];
  });

  it('resolves a whole-value template deep inside an object', () => {
    process.env[TEST_ENV_KEY] = 'sk-swarm-literal-1234';

    const result = resolveEnvTemplates('providers.swarmtest', {
      protocol: 'openrouter',
      apiKey: '${DRONE_TEST_UNDERLAY_KEY}',
    });

    expect(result).toEqual({
      ok: true,
      value: { protocol: 'openrouter', apiKey: 'sk-swarm-literal-1234' },
    });
  });

  it('resolves mid-string templates', () => {
    process.env[TEST_ENV_KEY] = 'sk-swarm-literal-1234';

    const result = resolveEnvTemplates(
      'llm.active',
      'prefix-${DRONE_TEST_UNDERLAY_KEY}-suffix'
    );

    expect(result).toEqual({
      ok: true,
      value: 'prefix-sk-swarm-literal-1234-suffix',
    });
  });

  it('fails with a reason naming the unset variable', () => {
    delete process.env[TEST_ENV_KEY];

    const result = resolveEnvTemplates('providers.swarmtest', {
      apiKey: '${DRONE_TEST_UNDERLAY_KEY}',
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('DRONE_TEST_UNDERLAY_KEY'),
    });
  });

  it('includes the row key in the failure reason', () => {
    delete process.env[TEST_ENV_KEY];

    const result = resolveEnvTemplates('providers.missing', {
      apiKey: '${DRONE_TEST_UNDERLAY_KEY}',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('providers.missing');
    }
  });

  it('returns non-template strings byte-identical', () => {
    process.env[TEST_ENV_KEY] = 'irrelevant';

    expect(resolveEnvTemplates('llm.active', 'swarm/model')).toEqual({
      ok: true,
      value: 'swarm/model',
    });
    expect(resolveEnvTemplates('llm.active', 'a$b no braces')).toEqual({
      ok: true,
      value: 'a$b no braces',
    });
  });

  it('passes through non-string scalars and walks nested arrays', () => {
    process.env[TEST_ENV_KEY] = 'sk-swarm-literal-1234';

    const result = resolveEnvTemplates('session.guardrail.identicalToolCalls', {
      maxHints: 3,
      enabled: false,
      nothing: null,
      list: ['plain', '${DRONE_TEST_UNDERLAY_KEY}', 7],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        maxHints: 3,
        enabled: false,
        nothing: null,
        list: ['plain', 'sk-swarm-literal-1234', 7],
      },
    });
  });
});

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
  afterEach(() => {
    delete process.env[TEST_ENV_KEY];
  });

  it('fetches the beacon merged config, nests flat keys, and resolves ${VAR} templates', async () => {
    process.env[TEST_ENV_KEY] = 'sk-swarm-literal-1234';
    const entries = [
      { key: 'llm.active', value: '"swarm/model"' },
      {
        key: 'providers.openrouter',
        value:
          '{"protocol":"openrouter","apiKey":"${DRONE_TEST_UNDERLAY_KEY}"}',
      },
    ];
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => entries,
      } as unknown as Response);
    const injector = new BeaconConfigInjector('http://localhost:3457');

    const result = await injector.inject();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3457/config');
    expect(result).toEqual({
      llm: { active: 'swarm/model' },
      providers: {
        openrouter: { protocol: 'openrouter', apiKey: 'sk-swarm-literal-1234' },
      },
    });
    vi.restoreAllMocks();
  });

  it('drops rows with unset variables and warns once per key', async () => {
    const warnings: string[] = [];
    const entries = [
      { key: 'llm.active', value: '"swarm/model"' },
      {
        key: 'providers.swarmtest',
        value:
          '{"protocol":"openrouter","apiKey":"${DRONE_TEST_UNDERLAY_KEY}"}',
      },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => entries,
    } as unknown as Response);
    const injector = new BeaconConfigInjector(
      'http://localhost:3457',
      (message: string) => warnings.push(message)
    );

    const first = await injector.inject();

    expect(first).toEqual({ llm: { active: 'swarm/model' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DRONE_TEST_UNDERLAY_KEY');
    expect(warnings[0]).toContain('providers.swarmtest');

    const second = await injector.inject();
    expect(second).toEqual(first);
    expect(warnings).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('skips non-allowlisted rows with templates without resolution warnings', async () => {
    const warnings: string[] = [];
    const entries = [
      { key: 'systemPrompt', value: '"${DRONE_TEST_UNDERLAY_KEY}"' },
      { key: 'llm.active', value: '"swarm/model"' },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => entries,
    } as unknown as Response);
    const injector = new BeaconConfigInjector(
      'http://localhost:3457',
      (message: string) => warnings.push(message)
    );

    const result = await injector.inject();

    expect(result).toEqual({ llm: { active: 'swarm/model' } });
    expect(warnings).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('returns cached interpolated config when the beacon becomes unreachable', async () => {
    process.env[TEST_ENV_KEY] = 'sk-swarm-literal-1234';
    const entries = [
      {
        key: 'providers.swarmtest',
        value:
          '{"protocol":"openrouter","apiKey":"${DRONE_TEST_UNDERLAY_KEY}"}',
      },
    ];
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => entries,
      } as unknown as Response)
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const injector = new BeaconConfigInjector('http://localhost:3457');

    const warm = await injector.inject();
    expect(warm).toEqual({
      providers: {
        swarmtest: { protocol: 'openrouter', apiKey: 'sk-swarm-literal-1234' },
      },
    });

    const cached = await injector.inject();
    expect(cached).toEqual(warm);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
