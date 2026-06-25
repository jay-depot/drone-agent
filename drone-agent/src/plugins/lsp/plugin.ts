import type { DronePlugin } from 'drone-core';
import process from 'node:process';
import { createServerManager } from './server.js';
import {
  createGetDiagnosticsTool,
  createHoverTool,
  createGoToDefinitionTool,
  createFindReferencesTool,
  createDocumentSymbolsTool,
  createWorkspaceSymbolTool,
  createSignatureHelpTool,
  createCompletionTool,
  createCodeActionTool,
  createRenameTool,
  createImplementationTool,
  createTypeDefinitionTool,
  createCallHierarchyIncomingTool,
  createCallHierarchyOutgoingTool,
  createFormattingTool,
  createServerStatusTool,
} from './tools.js';

export const lspPlugin: DronePlugin = {
  metadata: {
    id: 'lsp',
    name: 'LSP',
    version: '0.1.0',
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

    // Register diagnostics prompt fragment
    registration.registerPromptFragment({
      key: 'diagnostics',
      phase: 'header',
      render: async () => server.renderDiagnosticsPrompt(),
    });

    // Register all tools
    const tools = [
      createGetDiagnosticsTool(server),
      createHoverTool(server),
      createGoToDefinitionTool(server),
      createFindReferencesTool(server),
      createDocumentSymbolsTool(server),
      createWorkspaceSymbolTool(server),
      createSignatureHelpTool(server),
      createCompletionTool(server),
      createCodeActionTool(server),
      createRenameTool(server),
      createImplementationTool(server),
      createTypeDefinitionTool(server),
      createCallHierarchyIncomingTool(server),
      createCallHierarchyOutgoingTool(server),
      createFormattingTool(server),
      createServerStatusTool(server),
    ];

    for (const tool of tools) {
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
