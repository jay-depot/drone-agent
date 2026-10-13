import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('writes the selected provider as an enabledPlugins override', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openai' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-test-openai' });
    askMock.mockResolvedValueOnce({ model: 'gpt-4o' });

    const setModel = vi.fn();

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation(setModel) as never,
      makeLogger() as never
    );

    const written = getWrittenConfig();
    expect(written['enabledPlugins']).toEqual({ openai: true });
    expect((written['llm'] as { active: string }).active).toBe('openai/gpt-4o');
    expect(process.env['OPENAI_API_KEY']).toBe('sk-test-openai');
    expect(setModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('writes exactly one override entry for the chosen provider', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openai' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-test-openai' });
    askMock.mockResolvedValueOnce({ model: 'gpt-4.1' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never
    );

    const written = getWrittenConfig();
    const enabled = written['enabledPlugins'] as Record<string, boolean>;
    expect(enabled).toEqual({ openai: true });
  });

  it('writes enabledPlugins for OpenRouter and Anthropic branches', async () => {
    askMock.mockResolvedValueOnce({ provider: 'openrouter' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-or-v1-test' });
    askMock.mockResolvedValueOnce({ model: 'openai/gpt-4o' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never
    );

    const openRouterConfig = getWrittenConfig();
    expect(openRouterConfig['enabledPlugins']).toEqual({ openrouter: true });
    expect((openRouterConfig['llm'] as { active: string }).active).toBe(
      'openrouter/openai/gpt-4o'
    );

    vi.clearAllMocks();
    askMock.mockResolvedValueOnce({ provider: 'anthropic' });
    askMock.mockResolvedValueOnce({ apiKey: 'sk-ant-test' });
    askMock.mockResolvedValueOnce({ model: 'claude-sonnet-4-6' });

    await runFirstRunSetup(
      makeEngineWithoutOllama() as never,
      makeConversation() as never,
      makeLogger() as never
    );

    const anthropicConfig = getWrittenConfig();
    expect(anthropicConfig['enabledPlugins']).toEqual({ anthropic: true });
    expect((anthropicConfig['llm'] as { active: string }).active).toBe(
      'anthropic/claude-sonnet-4-6'
    );
  });
});
