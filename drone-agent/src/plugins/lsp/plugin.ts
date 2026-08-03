import type { DronePlugin, DroneToolDefinition } from 'drone-core';
import process from 'node:process';
import { createServerManager } from './server.js';
import {
  createGetDiagnosticsTool,
  createGoToTool,
  createFindReferencesTool,
  createSymbolsTool,
  createInspectTool,
  createCompletionTool,
  createCodeActionTool,
  createRenameTool,
  createCallHierarchyTool,
  createFormattingTool,
} from './tools/index.js';

export const lspPlugin: DronePlugin = {
  metadata: {
    id: 'lsp',
    name: 'LSP',
    version: '0.2.0',
    description:
      'Adds lightweight language-server diagnostics and semantic queries.',
    defaultEnabled: false,
  },
  register: async registration => {
    const lspConfig = registration.getConfig().lsp;

    const server = createServerManager({
      workspaceRoot: process.cwd(),
      lspConfig,
      logger: registration.logger,
    });

    // Register diagnostics + server status prompt fragment
    registration.registerPromptFragment({
      key: 'lsp-status',
      phase: 'header',
      render: async () => {
        const diagPrompt = server.renderDiagnosticsPrompt();
        const states = server.getServerStates();
        const parts: string[] = [];

        if (states.length > 0) {
          const serverLines = states.map(s => `${s.language}: ${s.status}`);
          parts.push(`# LSP Servers\n\n${serverLines.join('\n')}`);
        }

        const available = server.getAvailableServers();
        if (available.length > 0) {
          const availableLines = available.map(
            s =>
              `- ${s.language} (${s.id}): available — mount and use LSP tools for this language`
          );
          parts.push(
            `## Available LSP Servers\n\n${availableLines.join('\n')}`
          );
        }

        if (diagPrompt) {
          parts.push(diagPrompt);
        }

        return parts.length > 0 ? parts.join('\n\n') : false;
      },
    });

    // Build all tool definitions and register them directly
    const toolFactories: Array<() => DroneToolDefinition> = [
      () => createGetDiagnosticsTool(server),
      () => createInspectTool(server),
      () => createGoToTool(server),
      () => createFindReferencesTool(server),
      () => createSymbolsTool(server),
      () => createCompletionTool(server),
      () => createCodeActionTool(server),
      () => createRenameTool(server),
      () => createCallHierarchyTool(server),
      () => createFormattingTool(server),
    ];

    for (const factory of toolFactories) {
      const tool = factory();
      registration.registerTool(tool);
    }

    // Wire lifecycle hooks
    registration.hooks.onPluginsLoaded(async () => {
      if (!lspConfig.enabled) {
        registration.logger.info('lsp runtime disabled by config');
        return;
      }

      await server.initialize();
      server.markDirty();
      if (
        server.getServerStates().every(state => state.status !== 'connected')
      ) {
        registration.logger.warn('no LSP servers connected for this session');
      }
    });

    registration.hooks.onBeforePrompt(async () => {
      if (!lspConfig.enabled) {
        return;
      }
      await server.refreshIfNeeded();
    });

    registration.hooks.onAfterToolCall(async () => {
      if (!lspConfig.enabled) {
        return;
      }
      server.markDirty();
    });

    registration.hooks.onShutdown(async () => {
      await server.shutdown();
    });
  },
};
