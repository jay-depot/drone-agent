import { ListToolsBlock } from '../../tui/components/ListToolsBlock.js';
import { MountToolBlock } from '../../tui/components/MountToolBlock.js';
import { UnmountToolBlock } from '../../tui/components/UnmountToolBlock.js';
import type {
  DronePersonaCapability,
  DronePlugin,
  DroneToolDefinition,
} from 'drone-core';
import { ToolMountingCache } from 'drone-core';
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
} from './tools/index.js';

const LSP_TOOL_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  {
    name: 'get_diagnostics',
    description:
      'Return the current LSP diagnostics for the workspace or a specific file.',
  },
  {
    name: 'hover',
    description:
      'Return LSP hover information for a symbol at a file, line, and column.',
  },
  {
    name: 'go_to_definition',
    description:
      'Resolve the definition location(s) for a symbol at a file, line, and column.',
  },
  {
    name: 'find_references',
    description:
      'Find references to a symbol at a file, line, and column, optionally excluding declarations.',
  },
  {
    name: 'document_symbols',
    description:
      'Return the symbols defined in a single file (functions, classes, variables, etc.).',
  },
  {
    name: 'workspace_symbol',
    description:
      'Search for symbols across the workspace by name. Supports fuzzy matching where the language server supports it.',
  },
  {
    name: 'signature_help',
    description:
      'Return LSP signature help for the function call at a given position.',
  },
  {
    name: 'completion',
    description:
      'Return LSP completion suggestions at a given position. Includes kind, detail, and documentation.',
  },
  {
    name: 'code_action',
    description:
      'Return LSP code actions (quick fixes, refactorings, source actions) for a file and range.',
  },
  {
    name: 'rename',
    description:
      'Rename a symbol across the workspace. Returns the workspace edit as JSON by default.',
  },
  {
    name: 'implementation',
    description:
      'Return locations that implement the interface or method at a position.',
  },
  {
    name: 'type_definition',
    description:
      'Return the type-definition location(s) for a symbol at a position.',
  },
  {
    name: 'call_hierarchy_incoming',
    description:
      'Return the call hierarchy chain of callers leading to the symbol at a position.',
  },
  {
    name: 'call_hierarchy_outgoing',
    description:
      'Return the call hierarchy chain of callees invoked by the symbol at a position.',
  },
  {
    name: 'formatting',
    description:
      'Format a file using the LSP server. Applies formatting edits directly.',
  },
  {
    name: 'server_status',
    description: 'List LSP server connection state for this session.',
  },
];

export const lspPlugin: DronePlugin = {
  metadata: {
    id: 'lsp',
    name: 'LSP',
    version: '0.1.0',
    description:
      'Adds lightweight language-server diagnostics and semantic queries.',
    defaultEnabled: false,
    dependencies: [{ id: 'persona', optional: true }],
  },
  register: async registration => {
    const personaCap = registration.request<DronePersonaCapability>('persona');
    const lspConfig = registration.getConfig().lsp;

    const server = createServerManager({
      workspaceRoot: process.cwd(),
      lspConfig,
      logger: registration.logger,
    });

    const lspCache = new ToolMountingCache('lsp');

    // Register diagnostics prompt fragment
    registration.registerPromptFragment({
      key: 'diagnostics',
      phase: 'header',
      render: async () => server.renderDiagnosticsPrompt(),
    });

    // Build all tool definitions and add them to the cache
    const toolFactories: Array<() => DroneToolDefinition> = [
      () => createGetDiagnosticsTool(server),
      () => createHoverTool(server),
      () => createGoToDefinitionTool(server),
      () => createFindReferencesTool(server),
      () => createDocumentSymbolsTool(server),
      () => createWorkspaceSymbolTool(server),
      () => createSignatureHelpTool(server),
      () => createCompletionTool(server),
      () => createCodeActionTool(server),
      () => createRenameTool(server),
      () => createImplementationTool(server),
      () => createTypeDefinitionTool(server),
      () => createCallHierarchyIncomingTool(server),
      () => createCallHierarchyOutgoingTool(server),
      () => createFormattingTool(server),
      () => createServerStatusTool(server),
    ];

    for (const factory of toolFactories) {
      const tool = factory();
      lspCache.addTool(tool.name, tool);
    }

    // ── Meta-tools ──────────────────────────────────────────────────────

    registration.registerTool({
      name: 'list_tools',
      description:
        'List all available LSP tools. Tools include: get_diagnostics, hover, go_to_definition, find_references, document_symbols, workspace_symbol, signature_help, completion, code_action, rename, implementation, type_definition, call_hierarchy_incoming, call_hierarchy_outgoing, formatting, server_status. Mount the ones you need with lsp__mount_tool.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      renderComponent: state => ListToolsBlock({ state }),
      execute: async () => {
        let tools = LSP_TOOL_DESCRIPTIONS;
        if (personaCap) {
          const descriptors = tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: undefined,
            defaultHidden: false,
          }));
          const filtered = personaCap.getFilteredTools(descriptors);
          const filteredNames = new Set(filtered.map(t => t.name));
          tools = tools.filter(t => filteredNames.has(t.name));
        }
        return JSON.stringify({ toolCount: tools.length, tools }, null, 2);
      },
    });

    registration.registerTool({
      name: 'mount_tool',
      description:
        'Mount a specific LSP tool so it becomes available as a native tool. Use lsp__list_tools to see available tools. Once mounted, the tool will appear in your tool list with its full schema.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description:
              'The name of the tool to mount (as shown by lsp__list_tools).',
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      renderComponent: state => MountToolBlock({ state }),
      execute: async input => {
        if (typeof input.tool !== 'string' || input.tool.trim().length === 0) {
          throw new Error('lsp__mount_tool requires a non-empty tool name.');
        }
        const toolName = input.tool.trim();
        const result = lspCache.mountTool(toolName, registration);
        if (!result) {
          return JSON.stringify(
            {
              success: false,
              error: `Unknown or already mounted tool: ${toolName}. Use lsp__list_tools to see available tools.`,
            },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            success: true,
            tool: toolName,
            description: result.description,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'unmount_tool',
      description:
        'Unmount a previously mounted LSP tool. This removes the tool from your active tool list to reduce clutter.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description:
              'The name of the tool to unmount (as shown by lsp__list_tools).',
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      renderComponent: state => UnmountToolBlock({ state }),
      execute: async input => {
        if (typeof input.tool !== 'string' || input.tool.trim().length === 0) {
          throw new Error('lsp__unmount_tool requires a non-empty tool name.');
        }
        const toolName = input.tool.trim();
        lspCache.unmountTool(toolName, registration);
        return JSON.stringify({ success: true, tool: toolName }, null, 2);
      },
    });

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
