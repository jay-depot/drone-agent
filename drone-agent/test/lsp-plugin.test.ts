import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  toToolResultContent,
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
      tools.set(tool.name, async (i: Record<string, unknown>) =>
        toToolResultContent(await tool.execute(i))
      );
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
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
  it('registers all 10 LSP tools', async () => {
    const tools = captureLspTools();
    const expected = [
      'get_diagnostics',
      'inspect',
      'go_to',
      'find_references',
      'symbols',
      'completion',
      'code_action',
      'rename',
      'call_hierarchy',
      'formatting',
    ];
    for (const name of expected) {
      expect(tools.has(name), `missing tool: ${name}`).toBe(true);
    }
    expect(tools.size).toBe(10);
  });

  it('registers lsp-status prompt fragment', async () => {
    const registration: DronePluginRegistration = {
      logger: silentLogger(),
      getConfig: () => createDefaultAgentConfig(),
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerSlashCommand: () => {},
      registerWorkflow: () => {},
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
        onShutdown: () => {},
        onSessionSafetyTrimWillRun: () => {},
        onSessionSafetyTrimApplied: () => {},
      },
      offer: () => {},
      request: <T>() => undefined as T | undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    };
    // Just verify no crash during registration
    await lspPlugin.register(registration);
  });
});
