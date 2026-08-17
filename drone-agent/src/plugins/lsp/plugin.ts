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

    // Static usage guidance for the LSP tools
    registration.registerPromptFragment({
      key: 'lsp-usage',
      phase: 'header',
      render: async () => `# LSP Usage

When resolving a symbol with the LSP tools, prefer the \`symbol\` parameter over
\`text\`. \`text\` is a raw substring search and will match call sites, so it is
ambiguous for any symbol used more than once; \`symbol\` resolves semantically via
document/workspace symbols. If \`symbol\` is ambiguous, pass \`surroundingText\` (a
few lines of surrounding context) to disambiguate.

\`call_hierarchy\` can return empty \`from\`/\`to\` arrays even when callers/callees
exist (a known LSP limitation for local functions). If a hierarchy result looks
suspiciously empty, check the \`warning\`/\`references\` fields or verify with
\`find_references\`.

Prefer \`symbols\` with \`scope: "document"\` when the target file is known.
Workspace-scope symbol search is exact-match-first (prefix matches only when no
exact matches exist) and deduplicated by location — set \`limit\` and expect to
filter.`,
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
