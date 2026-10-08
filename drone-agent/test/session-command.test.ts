import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmSessionCommand } from '../src/plugins/swarm/session-command.js';
import {
  createDefaultAgentConfig,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneSlashCommandContext,
} from 'drone-core';

// The command delegates the actual import to `runSessionImport`; the deep
// import semantics are unit-tested in `session-import.test.ts`. Here we verify
// the command's own responsibilities: subcommand routing, argument parsing,
// and correct dependency assembly.
vi.mock('../src/plugins/swarm/session-import.js', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../src/plugins/swarm/session-import.js')
    >();
  return {
    ...actual,
    runSessionImport: vi.fn(),
  };
});

import { runSessionImport } from '../src/plugins/swarm/session-import.js';

function makeLlm(): DroneLlmCapability {
  const provider: DroneLlmProvider = { chat: async () => ({ message: '' }) };
  return {
    getActiveProvider: () => provider,
    resolveModelForRole: () => ({
      provider,
      providerId: 'test',
      model: 'model-x',
    }),
    registerDriver: () => {},
    describeImages: async images => images,
    getUsageLedger: () => [],
    getActiveProviderId: () => 'test',
    getAvailableProviders: () => [],
    activateProvider: () => {},
    getModel: () => 'model-x',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: () => {},
    listModels: async () => [],
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

function makeContext(overrides: Partial<DroneSlashCommandContext> = {}) {
  const logs: string[] = [];
  const warns: string[] = [];
  const runHooks = vi.fn().mockResolvedValue(undefined);
  const ctx: DroneSlashCommandContext = {
    line: '/swarm-session',
    args: [],
    logger: {
      info: m => logs.push(m),
      warn: m => warns.push(m),
      error: m => logs.push(m),
    },
    engine: {
      executeTool: async () => '{}',
      runHooks,
      getCapability: () => undefined,
      getConfig: () => createDefaultAgentConfig(),
    },
    sessionManager: {
      appendUserMessage: () => {},
      appendAssistantMessage: () => {},
      appendToolResult: () => {},
    },
    ...overrides,
  };
  return { ctx, logs, warns, runHooks };
}

const BASE_URL = 'http://localhost:3457';
const CONFIG = { maxChunks: 5, chunkTokenBudgetPercent: 12 };

describe('createSwarmSessionCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(runSessionImport).mockReset();
    vi.mocked(runSessionImport).mockResolvedValue({ ok: true, summary: 'ok' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists sessions excluding the current one', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 'current',
            personaId: null,
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'ss1',
            personaId: 'coder',
            status: 'ended',
            createdAt: 2,
            updatedAt: 3,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { ctx, logs } = makeContext({ args: ['list'] });
    const cmd = createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    );
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    // Hits the beacon proxy route, not the coordinator directly.
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/sessions?limit=10`);
    expect(logs.join('\n')).toContain('ss1');
    expect(logs.join('\n')).not.toContain('current ');
  });

  it('warns on unknown subcommand', async () => {
    const { ctx, warns } = makeContext({ args: ['bogus'] });
    const handled = await createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    ).handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain('Unknown swarm-session command');
  });

  it('warns when import is missing a session id', async () => {
    const { ctx, warns } = makeContext({ args: ['import'] });
    const handled = await createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    ).handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain(
      'Usage: /swarm-session import <sessionId>'
    );
    expect(runSessionImport).not.toHaveBeenCalled();
  });

  describe('import delegation', () => {
    it('delegates to runSessionImport with the session id and parsed --from', async () => {
      const { ctx } = makeContext({ args: ['import', 'ss1', '--from', '2'] });
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        async () => 1000
      ).handler(ctx);

      expect(handled).toBe(true);
      expect(runSessionImport).toHaveBeenCalledTimes(1);
      const call = vi.mocked(runSessionImport).mock.calls[0];
      expect(call?.[1]).toBe('ss1');
      expect(call?.[2]).toEqual({ from: 2 });
    });

    it('defaults --from to 1 when omitted', async () => {
      const { ctx } = makeContext({ args: ['import', 'ss1'] });
      await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        async () => 1000
      ).handler(ctx);

      const call = vi.mocked(runSessionImport).mock.calls[0];
      expect(call?.[2]).toEqual({ from: 1 });
    });

    it('assembles deps: baseUrl, currentSessionId, config, logger, sessionManager, llm', async () => {
      const llm = makeLlm();
      const { ctx } = makeContext({
        args: ['import', 'ss1'],
        engine: {
          executeTool: async () => '{}',
          runHooks: vi.fn().mockResolvedValue(undefined),
          getCapability: <T>() => llm as unknown as T,
          getConfig: () => createDefaultAgentConfig(),
        },
      });
      await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        async () => 1000
      ).handler(ctx);

      const deps = vi.mocked(runSessionImport).mock.calls[0]?.[0];
      expect(deps?.baseUrl).toBe(BASE_URL);
      expect(deps?.currentSessionId).toBe('current');
      expect(deps?.config).toEqual(CONFIG);
      expect(deps?.logger).toBe(ctx.logger);
      expect(deps?.sessionManager).toBe(ctx.sessionManager);
      expect(deps?.llm).toBe(llm);
    });

    it('wires runAfterToolCallHooks to the engine onAfterToolCall hook', async () => {
      const runHooks = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeContext({
        args: ['import', 'ss1'],
        engine: {
          executeTool: async () => '{}',
          runHooks,
          getCapability: () => undefined,
          getConfig: () => createDefaultAgentConfig(),
        },
      });
      await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        async () => 1000
      ).handler(ctx);

      const deps = vi.mocked(runSessionImport).mock.calls[0]?.[0];
      await deps?.runAfterToolCallHooks();
      expect(runHooks).toHaveBeenCalledWith('onAfterToolCall');
    });

    it('uses the injected context-window resolver', async () => {
      const getContextWindowTokens = vi.fn().mockResolvedValue(1234);
      const { ctx } = makeContext({ args: ['import', 'ss1'] });
      await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        getContextWindowTokens
      ).handler(ctx);

      const deps = vi.mocked(runSessionImport).mock.calls[0]?.[0];
      await expect(deps!.getContextWindowTokens()).resolves.toBe(1234);
      expect(getContextWindowTokens).toHaveBeenCalledTimes(1);
    });

    it('falls back to session.contextWindowTokens when no resolver is injected', async () => {
      const { ctx } = makeContext({ args: ['import', 'ss1'] });
      await createSwarmSessionCommand(BASE_URL, 'current', CONFIG).handler(ctx);

      const deps = vi.mocked(runSessionImport).mock.calls[0]?.[0];
      await expect(deps!.getContextWindowTokens()).resolves.toBe(32768);
    });
  });
});
