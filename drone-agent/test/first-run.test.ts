import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAgentConfig, type DroneAgentConfig } from 'drone-core';
import { runFirstRunSetup } from '../src/first-run.js';

const { mkdirMock, writeFileMock, askMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(async () => undefined),
  writeFileMock: vi.fn(async () => undefined),
  askMock:
    vi.fn<
      (questions: Array<{ id: string }>) => Promise<Record<string, string>>
    >(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

vi.mock('../src/elicitation.js', () => ({
  createReadlineElicitation: () => ({
    ask: askMock,
  }),
}));

type MinimalEngine = {
  getCapability: <T>(pluginId: string) => T | undefined;
};

type MinimalConversation = {
  setModel: (model: string) => void;
};

type MinimalLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

function makeEngineWithoutOllama(): MinimalEngine {
  return {
    getCapability: () => undefined,
  };
}

function makeConversation(setModel = vi.fn()): MinimalConversation {
  return {
    setModel,
  };
}

function makeLogger(): MinimalLogger {
  return {
    info: () => {},
    warn: () => {},
  };
}

function getWrittenConfig(): Record<string, unknown> {
  expect(writeFileMock).toHaveBeenCalledTimes(1);
  const payload = (writeFileMock.mock.calls[0] as unknown[])?.[1];
  if (typeof payload !== 'string') {
    throw new Error('Expected first-run writeFile payload to be a string.');
  }
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('runFirstRunSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('writes enabledPlugins and appends selected provider when missing', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openai' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-test-openai' });
    askMock.mockResolvedValueOnce({ model: 'gpt-4o' });

    const setModel = vi.fn();
    const config: DroneAgentConfig = createDefaultAgentConfig();

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation(setModel) as never,
      makeLogger() as never,
      config,
      ['startup', 'llm', 'ollama']
    );

    const written = getWrittenConfig();
    expect(written['enabledPlugins']).toEqual([
      'startup',
      'llm',
      'ollama',
      'openai',
    ]);
    expect((written['llm'] as { provider: string }).provider).toBe('openai');
    expect(process.env['OPENAI_API_KEY']).toBe('sk-test-openai');
    expect(setModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('does not duplicate provider when already in defaults', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openai' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-test-openai' });
    askMock.mockResolvedValueOnce({ model: 'gpt-4.1' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never,
      createDefaultAgentConfig(),
      ['startup', 'llm', 'openai']
    );

    const written = getWrittenConfig();
    const enabled = written['enabledPlugins'] as string[];
    expect(enabled.filter(id => id === 'openai')).toHaveLength(1);
  });

  it('writes enabledPlugins for OpenRouter and Anthropic branches', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openrouter' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-or-v1-test' });
    askMock.mockResolvedValueOnce({ model: 'openai/gpt-4o' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never,
      createDefaultAgentConfig(),
      ['startup', 'llm']
    );

    const openRouterConfig = getWrittenConfig();
    expect(openRouterConfig['enabledPlugins']).toEqual([
      'startup',
      'llm',
      'openrouter',
    ]);
    expect((openRouterConfig['llm'] as { provider: string }).provider).toBe(
      'openrouter'
    );

    vi.clearAllMocks();
    askMock.mockResolvedValueOnce({ provider: 'anthropic' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-ant-test' });
    askMock.mockResolvedValueOnce({ model: 'claude-sonnet-4-6' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never,
      createDefaultAgentConfig(),
      ['startup', 'llm']
    );

    const anthropicConfig = getWrittenConfig();
    expect(anthropicConfig['enabledPlugins']).toEqual([
      'startup',
      'llm',
      'anthropic',
    ]);
    expect((anthropicConfig['llm'] as { provider: string }).provider).toBe(
      'anthropic'
    );
  });
});
