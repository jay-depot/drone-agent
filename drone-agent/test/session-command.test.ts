import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmSessionCommand } from '../src/plugins/swarm/session-command.js';
import {
  createDefaultAgentConfig,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneSlashCommandContext,
} from 'drone-core';

vi.mock('../src/plugins/swarm/session-import.js', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../src/plugins/swarm/session-import.js')
    >();
  return {
    ...actual,
    fetchTranscript: vi.fn(),
    splitTranscriptIntoChunks: vi.fn(),
    summarizeChunk: vi.fn(),
  };
});

import {
  fetchTranscript,
  splitTranscriptIntoChunks,
  summarizeChunk,
} from '../src/plugins/swarm/session-import.js';

/**
 * Build a mock DroneLlmCapability whose active provider can be shaped per test.
 * Context-window resolution is injected into the command under test, so the
 * provider mock itself needs none.
 */
function makeLlm(
  providerOverrides: Partial<DroneLlmProvider> = {}
): DroneLlmCapability {
  const provider: DroneLlmProvider = {
    chat: async () => ({ message: '' }),
    ...providerOverrides,
  };
  return {
    getActiveProvider: () => provider,
    resolveModelForRole: () => ({
      provider,
      providerId: 'test',
      model: 'model-x',
    }),
    registerDriver: () => {},
    describeImages: async images => images,
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
  const calls: Array<{ kind: 'assistant' | 'tool'; args: unknown[] }> = [];
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
      runHooks: async () => {},
      getCapability: () => undefined,
      getConfig: () => createDefaultAgentConfig(),
    },
    sessionManager: {
      appendUserMessage: () => {},
      appendAssistantMessage: (...args: unknown[]) =>
        calls.push({ kind: 'assistant', args }),
      appendToolResult: (...args: unknown[]) =>
        calls.push({ kind: 'tool', args }),
    },
    ...overrides,
  };
  return { ctx, logs, warns, calls };
}

const BASE_URL = 'http://localhost:3457';
const CONFIG = { maxChunks: 5, chunkTokenBudgetPercent: 12 };

describe('createSwarmSessionCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetchTranscript).mockReset();
    vi.mocked(splitTranscriptIntoChunks).mockReset();
    vi.mocked(summarizeChunk).mockReset();
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

  it('rejects importing the current session', async () => {
    const { ctx, warns } = makeContext({ args: ['import', 'current'] });
    const cmd = createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    );
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain('Cannot import the current session');
  });

  it('warns on unknown subcommand', async () => {
    const { ctx, warns } = makeContext({ args: ['bogus'] });
    const cmd = createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    );
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain('Unknown swarm-session command');
  });

  it('warns when import is missing a session id', async () => {
    const { ctx, warns } = makeContext({ args: ['import'] });
    const cmd = createSwarmSessionCommand(
      BASE_URL,
      'current',
      CONFIG,
      async () => 1000
    );
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain(
      'Usage: /swarm-session import <sessionId>'
    );
  });

  describe('import success path', () => {
    beforeEach(() => {
      vi.mocked(fetchTranscript).mockResolvedValue(
        '# Session ss2\n\n--- Turn 1 ---\n[user] hello\n--- Turn 2 ---\n[user] world'
      );
      vi.mocked(splitTranscriptIntoChunks).mockImplementation(
        (_transcript, maxChunks) => {
          const n = Math.min(maxChunks, 3);
          return Array.from({ length: n }, (_, i) => `chunk-${i + 1}`);
        }
      );
    });

    function importContext(args: string[]) {
      const runHooks = vi.fn().mockResolvedValue(undefined);
      const getContextWindowTokens = vi.fn().mockResolvedValue(1000);
      const base = makeContext({
        args,
        engine: {
          executeTool: async () => '{}',
          runHooks,
          getCapability: <T>(_pluginId: string) => makeLlm() as T,
          getConfig: () => createDefaultAgentConfig(),
        },
      });
      return { ...base, runHooks, getContextWindowTokens };
    }

    it('warns and bails when the LLM broker is unavailable', async () => {
      const { ctx, warns } = makeContext({ args: ['import', 'ss1'] });
      const cmd = createSwarmSessionCommand(BASE_URL, 'current', CONFIG);
      const handled = await cmd.handler(ctx);
      expect(handled).toBe(true);
      expect(warns.join('\n')).toContain(
        'LLM provider broker is not available.'
      );
    });

    it('imports N chunks into N turns and calls onAfterToolCall between chunks', async () => {
      vi.mocked(summarizeChunk).mockImplementation(
        async (_p, _m, chunk) => `summary for ${chunk}`
      );
      const { ctx, calls, logs, runHooks, getContextWindowTokens } =
        importContext(['import', 'ss1']);
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        getContextWindowTokens
      ).handler(ctx);

      expect(handled).toBe(true);
      // The injected resolver produces the per-chunk token budget.
      expect(getContextWindowTokens).toHaveBeenCalledTimes(1);
      // 3 chunks → 3 assistant (tool-call) + 3 tool results = 6 calls.
      expect(calls.length).toBe(6);
      expect(summarizeChunk).toHaveBeenCalledTimes(3);
      // onAfterToolCall fires between chunks, not after the last: N-1 = 2.
      expect(runHooks).toHaveBeenCalledTimes(2);
      expect(runHooks).toHaveBeenCalledWith('onAfterToolCall');
      expect(logs.join('\n')).toContain(
        'Imported chunks 1..3 from session ss1.'
      );
    });

    it('aborts with a resume hint when a chunk fails mid-import', async () => {
      vi.mocked(summarizeChunk).mockImplementation(async (_p, _m, chunk) => {
        if (chunk === 'chunk-2') throw new Error('provider down');
        return `summary for ${chunk}`;
      });
      const { ctx, warns, calls, getContextWindowTokens } = importContext([
        'import',
        'ss1',
      ]);
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        getContextWindowTokens
      ).handler(ctx);

      expect(handled).toBe(true);
      // Chunk 1 imported, chunk 2 failed → 1 assistant + 1 tool call.
      expect(calls.length).toBe(2);
      const message = warns.join('\n');
      expect(message).toContain('Failed to summarize chunk 2');
      expect(message).toContain('Import aborted: imported chunks 1..1 of 3');
      expect(message).toContain(
        'Resume with: /swarm-session import ss1 --from 2'
      );
    });

    it('resumes from --from N, keeping original chunk indices', async () => {
      vi.mocked(summarizeChunk).mockImplementation(
        async (_p, _m, chunk) => `summary for ${chunk}`
      );
      const { ctx, calls, logs, getContextWindowTokens } = importContext([
        'import',
        'ss1',
        '--from',
        '2',
      ]);
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        getContextWindowTokens
      ).handler(ctx);

      expect(handled).toBe(true);
      // Only chunks 2 and 3 are imported (2 assistant + 2 tool = 4 calls).
      expect(calls.length).toBe(4);
      const chunks = vi.mocked(summarizeChunk).mock.calls.map(c => c[2]);
      expect(chunks).toEqual(['chunk-2', 'chunk-3']);
      expect(logs.join('\n')).toContain(
        'Imported chunks 2..3 from session ss1.'
      );
    });

    it('rejects an out-of-range --from value', async () => {
      vi.mocked(summarizeChunk).mockImplementation(
        async (_p, _m, chunk) => `summary for ${chunk}`
      );
      const { ctx, warns, calls, getContextWindowTokens } = importContext([
        'import',
        'ss1',
        '--from',
        '9',
      ]);
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG,
        getContextWindowTokens
      ).handler(ctx);

      expect(handled).toBe(true);
      expect(warns.join('\n')).toContain('--from 9 is out of range');
      expect(calls.length).toBe(0);
      expect(summarizeChunk).not.toHaveBeenCalled();
    });

    it('falls back to session.contextWindowTokens when no resolver is injected', async () => {
      vi.mocked(summarizeChunk).mockImplementation(
        async (_p, _m, _chunk, budget) => `budget ${budget}`
      );
      const { ctx, logs } = importContext(['import', 'ss1']);
      const handled = await createSwarmSessionCommand(
        BASE_URL,
        'current',
        CONFIG
      ).handler(ctx);

      expect(handled).toBe(true);
      // Default config context window is 32768 → floor(32768 * 12%) = 3932.
      expect(logs.join('\n')).toContain('(3932 tokens each)');
    });
  });
});
