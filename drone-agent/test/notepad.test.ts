import { describe, expect, it } from 'vitest';
import type {
  DronePluginRegistration,
  DronePromptFragment,
  DroneToolDefinition,
} from 'drone-core';
import { createDefaultAgentConfig, toToolResultContent } from 'drone-core';
import { notepadPlugin } from '../src/plugins/notepad.js';

function createMockRegistration(): {
  registration: DronePluginRegistration;
  tools: { name: string; execute: DroneToolDefinition['execute'] }[];
  prompts: DronePromptFragment[];
} {
  const tools: { name: string; execute: DroneToolDefinition['execute'] }[] = [];
  const prompts: DronePromptFragment[] = [];
  const registration: DronePluginRegistration = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getConfig: () => createDefaultAgentConfig(),
    registerTool: (tool: {
      name: string;
      execute: DroneToolDefinition['execute'];
    }) => {
      tools.push(tool);
    },
    registerPromptFragment: (fragment: DronePromptFragment) => {
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
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({}),
    requestElicitation: () => undefined,
    mountTool: () => undefined,
    unmountTool: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
  };
  return { registration, tools, prompts };
}

describe('notepad manage tool', () => {
  async function setup() {
    const { registration, tools, prompts } = createMockRegistration();
    await notepadPlugin.register(registration);
    const manageTool = tools.find(t => t.name === 'manage')!;
    const fragment = prompts[0];
    return { manageTool, fragment };
  }

  it('rejects unknown action instead of silently succeeding', async () => {
    const { manageTool } = await setup();
    const parsed = JSON.parse(
      toToolResultContent(
        await manageTool.execute({ action: 'bogus', content: 'x' })
      )
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/must be set, clear, or append/);
  });

  it('rejects omitted action instead of silently succeeding', async () => {
    const { manageTool } = await setup();
    const parsed = JSON.parse(
      toToolResultContent(await manageTool.execute({}))
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/must be set, clear, or append/);
  });

  it('leaves notepad state untouched after failed actions', async () => {
    const { manageTool, fragment } = await setup();
    await manageTool.execute({ action: 'bogus' });
    await manageTool.execute({});
    expect(await fragment.render()).toBe('');
  });

  it('set replaces contents and renders in the prompt fragment', async () => {
    const { manageTool, fragment } = await setup();

    const result = await manageTool.execute({
      action: 'set',
      content: 'first note',
    });
    expect(JSON.parse(toToolResultContent(result)).success).toBe(true);

    const second = await manageTool.execute({
      action: 'set',
      content: 'second note',
    });
    expect(JSON.parse(toToolResultContent(second)).success).toBe(true);

    const rendered = await fragment.render();
    expect(rendered).toContain('Session Notepad');
    expect(rendered).toContain('second note');
    expect(rendered).not.toContain('first note');
  });

  it('append adds to existing contents', async () => {
    const { manageTool, fragment } = await setup();

    await manageTool.execute({ action: 'set', content: 'line one' });
    await manageTool.execute({ action: 'append', content: 'line two' });

    const rendered = await fragment.render();
    expect(rendered).toContain('line one');
    expect(rendered).toContain('line two');
  });

  it('clear empties the notepad', async () => {
    const { manageTool, fragment } = await setup();

    await manageTool.execute({ action: 'set', content: 'temporary' });
    const result = await manageTool.execute({ action: 'clear' });
    expect(JSON.parse(toToolResultContent(result)).success).toBe(true);
    expect(await fragment.render()).toBe('');
  });

  it('rejects non-string content for set and append', async () => {
    const { manageTool } = await setup();
    for (const action of ['set', 'append'] as const) {
      const parsed = JSON.parse(
        toToolResultContent(await manageTool.execute({ action }))
      );
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/Missing content/);
    }
  });
});
