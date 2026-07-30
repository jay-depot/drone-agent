import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { lspPlugin } from '../src/plugins/lsp/plugin.js';
import { silentLogger } from './helpers.js';

/** Register the LSP plugin and return a name -> execute map. */
function captureLspTools(): Map<
  string,
  (i: Record<string, unknown>) => Promise<string>
> {
  const tools = new Map<
    string,
    (i: Record<string, unknown>) => Promise<string>
  >();
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.set(tool.name, tool.execute);
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };
  lspPlugin.register(registration);
  return tools;
}

describe('lsp plugin integration', () => {
  it('registers only 3 meta-tools (list_tools, mount_tool, unmount_tool)', async () => {
    const tools = captureLspTools();
    const expected = ['list_tools', 'mount_tool', 'unmount_tool'];
    for (const name of expected) {
      expect(tools.has(name), `missing meta-tool: ${name}`).toBe(true);
    }
    expect(tools.size).toBe(3);
  });

  it('list_tools returns all 16 tool descriptions', async () => {
    const tools = captureLspTools();
    const result = JSON.parse(await tools.get('list_tools')!({}));
    expect(result.toolCount).toBe(16);
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_diagnostics');
    expect(names).toContain('hover');
    expect(names).toContain('go_to_definition');
    expect(names).toContain('find_references');
    expect(names).toContain('document_symbols');
    expect(names).toContain('workspace_symbol');
    expect(names).toContain('signature_help');
    expect(names).toContain('completion');
    expect(names).toContain('code_action');
    expect(names).toContain('rename');
    expect(names).toContain('implementation');
    expect(names).toContain('type_definition');
    expect(names).toContain('call_hierarchy_incoming');
    expect(names).toContain('call_hierarchy_outgoing');
    expect(names).toContain('formatting');
    expect(names).toContain('server_status');
  });

  it('mount_tool mounts a tool and it becomes callable', async () => {
    const tools = captureLspTools();
    // Mount the server_status tool
    const mountResult = JSON.parse(
      await tools.get('mount_tool')!({ tool: 'server_status' })
    );
    expect(mountResult.success).toBe(true);
    expect(mountResult.tool).toBe('server_status');

    // Now server_status should be registered
    expect(tools.has('server_status')).toBe(true);

    // Call the mounted server_status tool
    const statusOut = JSON.parse(await tools.get('server_status')!({}));
    expect(statusOut).toHaveProperty('servers');
  });

  it('mount_tool rejects an unknown tool name', async () => {
    const tools = captureLspTools();
    const result = JSON.parse(
      await tools.get('mount_tool')!({ tool: 'nonexistent' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('unmount_tool removes a mounted tool', async () => {
    const tools = captureLspTools();
    // Mount first
    await tools.get('mount_tool')!({ tool: 'server_status' });
    expect(tools.has('server_status')).toBe(true);

    // Unmount
    const unmountResult = JSON.parse(
      await tools.get('unmount_tool')!({ tool: 'server_status' })
    );
    expect(unmountResult.success).toBe(true);
    expect(unmountResult.tool).toBe('server_status');
  });
});
