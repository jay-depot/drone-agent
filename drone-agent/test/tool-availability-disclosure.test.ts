import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneConversationEvent,
  type DroneToolDefinition,
} from 'drone-core';
import { createTestEngine, createTestPlugin, silentLogger } from './helpers.js';

function makeTool(name: string): DroneToolDefinition {
  return {
    name,
    description: `${name} tool`,
    execute: async () => name,
  };
}

async function footerText(
  engine: ReturnType<typeof createTestEngine>
): Promise<string> {
  return (await engine.renderPromptFragmentsByPhase('footer')).join('\n\n');
}

function engineWithTools(
  names: string[],
  overrides: { announceToolRemovals?: boolean } = {}
): ReturnType<typeof createTestEngine> {
  const config = createDefaultAgentConfig();
  if (overrides.announceToolRemovals !== undefined) {
    config.session.announceToolRemovals = overrides.announceToolRemovals;
  }
  return createTestEngine({
    plugins: [
      createTestPlugin({
        id: 'test',
        tools: names.map(makeTool),
      }),
    ],
    config,
    logger: silentLogger(),
  });
}

describe('engine tool-availability disclosure', () => {
  it('lists an auto-unmounted tool in the footer fragment', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    engine.mountTool('test__alpha');
    engine.unmountTool('test__alpha');

    const footer = await footerText(engine);
    expect(footer).toContain('# No-longer callable tools');
    expect(footer).toContain(
      'test__alpha (Automatically unmounted, mount again if needed)'
    );
  });

  it('marks a registry-removed tool as do-not-call', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    engine.mountTool('test__alpha');
    engine.unregisterTool('test__alpha');

    const footer = await footerText(engine);
    expect(footer).toContain(
      'test__alpha (Unregistered, do not attempt to call or mount again)'
    );
  });

  it('renders false (absent) after the tool is re-mounted', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    engine.mountTool('test__alpha');
    engine.unmountTool('test__alpha');
    expect(await footerText(engine)).toContain('# No-longer callable tools');

    engine.mountTool('test__alpha');
    expect(await footerText(engine)).not.toContain(
      '# No-longer callable tools'
    );
  });

  it('does not list a tool the model unmounted itself via runtime__unmount_tool', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    engine.mountTool('test__alpha');
    await engine.executeTool('runtime__unmount_tool', { tool: 'test__alpha' });

    expect(await footerText(engine)).not.toContain(
      '# No-longer callable tools'
    );
  });

  it('never lists when session.announceToolRemovals is false', async () => {
    const engine = engineWithTools(['alpha'], { announceToolRemovals: false });
    await engine.initialize();
    engine.mountTool('test__alpha');
    engine.unmountTool('test__alpha');

    expect(await footerText(engine)).not.toContain(
      '# No-longer callable tools'
    );
  });

  it('caps the disclosure at 20 entries with an overflow line', async () => {
    const names = Array.from(
      { length: 25 },
      (_, i) => `t${String(i).padStart(2, '0')}`
    );
    const engine = engineWithTools(names);
    await engine.initialize();
    for (const name of names) {
      engine.mountTool(`test__${name}`);
    }
    for (const name of names) {
      engine.unmountTool(`test__${name}`);
    }

    const footer = await footerText(engine);
    const listed = footer.split('\n').filter(line => line.startsWith('- '));
    expect(listed).toHaveLength(21); // 20 entries + the overflow line
    expect(footer).toContain('…and 5 more');
  });

  it('emits one coalesced notice for a burst of removals', async () => {
    const engine = engineWithTools(['alpha', 'beta']);
    await engine.initialize();
    const notices: DroneConversationEvent[] = [];
    engine.onConversationEvent(event => {
      if (event.kind === 'notice') notices.push(event);
    });

    engine.mountTool('test__alpha');
    engine.mountTool('test__beta');
    engine.unmountTool('test__alpha');
    engine.unmountTool('test__beta');

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'notice',
      content: '[2 tool(s) are no longer callable]',
    });
  });

  it('stays silent for a net-zero unmount then re-mount', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    const notices: DroneConversationEvent[] = [];
    engine.onConversationEvent(event => {
      if (event.kind === 'notice') notices.push(event);
    });

    engine.mountTool('test__alpha');
    engine.unmountTool('test__alpha');
    engine.mountTool('test__alpha');

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(notices).toHaveLength(0);
  });

  it('clears the disclosure on the session boundary', async () => {
    const engine = engineWithTools(['alpha']);
    await engine.initialize();
    engine.mountTool('test__alpha');
    engine.unmountTool('test__alpha');
    expect(await footerText(engine)).toContain('# No-longer callable tools');

    await engine.clearSession();
    expect(await footerText(engine)).not.toContain(
      '# No-longer callable tools'
    );
  });
});
