import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePlugin,
  type DronePluginRegistration,
  type DronePortableContextContributor,
} from 'drone-core';
import { todoPlugin } from '../src/plugins/todo/index.js';
import { focusPlugin } from '../src/plugins/focus.js';
import { notepadPlugin } from '../src/plugins/notepad.js';
import { silentLogger } from './helpers.js';

type Capture = {
  registration: DronePluginRegistration;
  tools: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  contributors: Map<string, DronePortableContextContributor>;
};

function makeCapture(): Capture {
  const contributors = new Map<string, DronePortableContextContributor>();
  const tools: Capture['tools'] = {};
  const capability = {
    registerContributor: (c: DronePortableContextContributor) =>
      contributors.set(c.id, c),
    unregisterContributor: (id: string) => contributors.delete(id),
    getContributors: () => [...contributors.values()],
    exportContext: async () => ({}) as never,
    importContext: async () => ({ warnings: [], unavailableTools: [] }),
  };
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools[tool.name] = tool.execute;
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onSessionRecycle: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(id: string) =>
      (id === 'portable-context' ? capability : undefined) as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
    listPlugins: () => [],
  };
  return { registration, tools, contributors };
}

async function register(plugin: DronePlugin): Promise<Capture> {
  const capture = makeCapture();
  await plugin.register(capture.registration);
  return capture;
}

describe('portable-context contributors', () => {
  it('todo exports and restores its items and nextId', async () => {
    const capture = await register(todoPlugin);
    await capture.tools.manage_list({
      action: 'add_item',
      title: 'first',
    });
    await capture.tools.manage_list({ action: 'add_item', title: 'second' });

    const contributor = capture.contributors.get('todo');
    if (!contributor) throw new Error('no todo contributor');
    const exported = (await contributor.export({ turns: [] })) as {
      items: Array<{ title: string }>;
      nextId: number;
    };
    expect(exported.items.map(i => i.title)).toEqual(['first', 'second']);

    // Restore into a cleared list.
    await capture.tools.manage_list({ action: 'replace_list', items: [] });
    await contributor.import?.(exported, { turns: [] });

    const listed = (await capture.tools.manage_list({
      action: 'list_items',
    })) as string;
    const parsed = JSON.parse(listed) as { items: Array<{ title: string }> };
    expect(parsed.items.map(i => i.title)).toEqual(['first', 'second']);
  });

  it('focus exports and restores the current focus', async () => {
    const capture = await register(focusPlugin);
    const contributor = capture.contributors.get('focus');
    if (!contributor) throw new Error('no focus contributor');
    await contributor.import?.(
      { currentFocus: 'ship the thing' },
      { turns: [] }
    );
    expect(await contributor.export({ turns: [] })).toEqual({
      currentFocus: 'ship the thing',
    });
  });

  it('notepad exports and restores its contents', async () => {
    const capture = await register(notepadPlugin);
    await capture.tools.manage({ action: 'set', content: 'note one' });
    const contributor = capture.contributors.get('notepad');
    if (!contributor) throw new Error('no notepad contributor');
    expect(await contributor.export({ turns: [] })).toEqual({
      currentNotepad: 'note one',
    });
    await contributor.import?.({ currentNotepad: 'restored' }, { turns: [] });
    expect(await contributor.export({ turns: [] })).toEqual({
      currentNotepad: 'restored',
    });
  });
});
