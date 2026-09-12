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
    const staticFragment = prompts.find(p => p.key === 'notepad-static');
    const currentFragment = prompts.find(p => p.key === 'notepad-current');
    return { manageTool, staticFragment, currentFragment };
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
    const { manageTool, currentFragment } = await setup();
    await manageTool.execute({ action: 'bogus' });
    await manageTool.execute({});
    expect(await currentFragment!.render()).toBe(false);
  });

  it('moves static guidance into the header and keeps the live note compact', async () => {
    const { manageTool, staticFragment, currentFragment } = await setup();

    const result = await manageTool.execute({
      action: 'set',
      content: 'first note',
    });
    expect(JSON.parse(toToolResultContent(result)).success).toBe(true);

    expect(staticFragment).toBeDefined();
    expect(await staticFragment!.render()).toContain('working memory');
    expect(await staticFragment!.render()).toContain('notepad__');

    const rendered = await currentFragment!.render();
    expect(rendered).toContain('Session Notepad');
    expect(rendered).toContain('first note');
    expect(rendered).not.toContain('Use the `notepad__*` tools');
  });

  it('append adds to existing contents', async () => {
    const { manageTool, currentFragment } = await setup();

    await manageTool.execute({ action: 'set', content: 'line one' });
    await manageTool.execute({ action: 'append', content: 'line two' });

    const rendered = await currentFragment!.render();
    expect(rendered).toContain('line one');
    expect(rendered).toContain('line two');
  });

  it('clear empties the notepad', async () => {
    const { manageTool, currentFragment } = await setup();

    await manageTool.execute({ action: 'set', content: 'temporary' });
    const result = await manageTool.execute({ action: 'clear' });
    expect(JSON.parse(toToolResultContent(result)).success).toBe(true);
    expect(await currentFragment!.render()).toBe(false);
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
