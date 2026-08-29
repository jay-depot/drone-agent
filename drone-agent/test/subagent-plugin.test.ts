import { describe, expect, it, vi } from 'vitest';
import { toToolResultContent } from 'drone-core';
import type {
  DronePluginRegistration,
  DronePromptFragment,
  DroneToolDefinition,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { subagentPlugin } from '../src/plugins/subagent/plugin.js';
import { silentLogger } from './helpers.js';

type CapturedTool = DroneToolDefinition;
type CapturedPrompt = DronePromptFragment;

function createMockRegistration(
  runtime: { isSubagent: boolean; subagentId?: string } | undefined
): {
  registration: DronePluginRegistration;
  tools: CapturedTool[];
  prompts: CapturedPrompt[];
} {
  const tools: CapturedTool[] = [];
  const prompts: CapturedPrompt[] = [];
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.push(tool);
    },
    registerPromptFragment: fragment => {
      prompts.push(fragment);
    },
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onShutdown: () => {},
      onSessionClear: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string) => {
      if (pluginId === 'runtime') {
        return runtime as unknown as T;
      }
      return undefined;
    },
    runWorkflow: async () => ({}),
    requestElicitation: () => undefined,
    mountTool: () => undefined,
    unmountTool: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    listMountedTools: () => [],
  };
  return { registration, tools, prompts };
}

describe('subagentPlugin', () => {
  it('registers the return tool (canonical subagent__return) in subagent mode', async () => {
    const { registration, tools, prompts } = createMockRegistration({
      isSubagent: true,
      subagentId: 'subagent-test-123',
    });

    await subagentPlugin.register(registration);

    // The return tool must be named 'return' so canonical becomes 'subagent__return'
    const returnTool = tools.find(t => t.name === 'return');
    expect(returnTool).toBeDefined();
    expect(returnTool?.description).toBe(
      'Return the result to the parent agent'
    );
    expect(tools.some(t => t.name === 'dispatch')).toBe(false);

    // The prompt fragment must reference subagent__return
    const prompt = prompts.find(p => p.key === 'subagent-return-instruction');
    expect(prompt).toBeDefined();
    expect(prompt?.phase).toBe('header');
    const text = await prompt!.render();
    expect(text).toContain('subagent__return');
    expect(text).not.toContain('subagent.return');
  });

  it('return tool signals stopLoop instead of calling process.exit', async () => {
    const { registration, tools } = createMockRegistration({
      isSubagent: true,
      subagentId: 'subagent-test-123',
    });

    await subagentPlugin.register(registration);
    const returnTool = tools.find(t => t.name === 'return');
    expect(returnTool).toBeDefined();

    const stopLoop = vi.fn();
    const result = await returnTool!.execute(
      { result: 'test-result' },
      undefined,
      { stopLoop }
    );

    expect(stopLoop).toHaveBeenCalled();
    const parsed = JSON.parse(toToolResultContent(result));
    expect(parsed.returned).toBe(true);
    expect(parsed.result).toBe('test-result');
  });
  it('return tool rejects omitted result with friendly error', async () => {
    const { registration, tools } = createMockRegistration({
      isSubagent: true,
      subagentId: 'subagent-test-123',
    });

    await subagentPlugin.register(registration);
    const returnTool = tools.find(t => t.name === 'return');

    const stopLoop = vi.fn();
    await expect(
      returnTool!.execute({}, undefined, { stopLoop })
    ).rejects.toThrow(/non-empty result/);
    expect(stopLoop).not.toHaveBeenCalled();
  });

  it('return tool rejects mistyped or blank result', async () => {
    const { registration, tools } = createMockRegistration({
      isSubagent: true,
      subagentId: 'subagent-test-123',
    });

    await subagentPlugin.register(registration);
    const returnTool = tools.find(t => t.name === 'return');

    await expect(
      returnTool!.execute({ result: 42 }, undefined, undefined)
    ).rejects.toThrow(/non-empty result/);
    await expect(
      returnTool!.execute({ result: '   ' }, undefined, undefined)
    ).rejects.toThrow(/non-empty result/);
  });
  it('registers the dispatch tool in main-agent mode (no return tool)', async () => {
    const { registration, tools } = createMockRegistration({
      isSubagent: false,
    });

    await subagentPlugin.register(registration);

    expect(tools.some(t => t.name === 'dispatch')).toBe(true);
    expect(tools.some(t => t.name === 'return')).toBe(false);
  });
});
