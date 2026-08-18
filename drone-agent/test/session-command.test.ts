import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmSessionCommand } from '../src/plugins/swarm/session-command.js';
import {
  createDefaultAgentConfig,
  type DroneSlashCommandContext,
} from 'drone-core';

function makeContext(overrides: Partial<DroneSlashCommandContext> = {}) {
  const logs: string[] = [];
  const warns: string[] = [];
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
      appendAssistantMessage: () => {},
      appendToolResult: () => {},
    },
    ...overrides,
  };
  return { ctx, logs, warns };
}

describe('createSwarmSessionCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
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
            updatedAt: 2,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { ctx, logs } = makeContext({ args: ['list'] });
    const cmd = createSwarmSessionCommand('http://localhost:3456', 'current', {
      maxChunks: 5,
      chunkTokenBudgetPercent: 12,
    });
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(logs.join('\n')).toContain('ss1');
    expect(logs.join('\n')).not.toContain('current ');
  });

  it('rejects importing the current session', async () => {
    const { ctx, warns } = makeContext({ args: ['import', 'current'] });
    const cmd = createSwarmSessionCommand('http://localhost:3456', 'current', {
      maxChunks: 5,
      chunkTokenBudgetPercent: 12,
    });
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain('Cannot import the current session');
  });

  it('warns on unknown subcommand', async () => {
    const { ctx, warns } = makeContext({ args: ['bogus'] });
    const cmd = createSwarmSessionCommand('http://localhost:3456', 'current', {
      maxChunks: 5,
      chunkTokenBudgetPercent: 12,
    });
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain('Unknown swarm-session command');
  });

  it('warns when import is missing a session id', async () => {
    const { ctx, warns } = makeContext({ args: ['import'] });
    const cmd = createSwarmSessionCommand('http://localhost:3456', 'current', {
      maxChunks: 5,
      chunkTokenBudgetPercent: 12,
    });
    const handled = await cmd.handler(ctx);
    expect(handled).toBe(true);
    expect(warns.join('\n')).toContain(
      'Usage: /swarm-session import <sessionId>'
    );
  });
});
