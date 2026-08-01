import { ListToolsBlock } from '../../tui/components/ListToolsBlock.js';
import { MountToolBlock } from '../../tui/components/MountToolBlock.js';
import { UnmountToolBlock } from '../../tui/components/UnmountToolBlock.js';
import type {
  DronePersonaCapability,
  RuntimeFlagRegistry,
  DronePlugin,
  DroneToolDefinition,
} from 'drone-core';
import { ToolMountingCache } from 'drone-core';
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

const LSP_TOOL_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  {
    name: 'get_diagnostics',
    description:
      'Return LSP diagnostics for the workspace or a specific file. Use this to check for errors and warnings.',
  },
  {
    name: 'inspect',
    description:
      'Inspect a symbol at a position — returns hover info (type, docs) and signature help (function parameters) together.',
  },
  {
    name: 'go_to',
    description:
      'Navigate to a symbol\'s definition, type definition, or implementation. Use kind: "definition" (default), "type", or "implementation".',
  },
  {
    name: 'find_references',
    description: 'Find all references to a symbol across the workspace.',
  },
  {
    name: 'symbols',
    description:
      'List symbols in a file (scope: "document") or search the workspace (scope: "workspace").',
  },
  {
    name: 'completion',
    description:
      'Get completion suggestions at a position — includes kind, detail, and documentation.',
  },
  {
    name: 'code_action',
    description:
      'Get quick fixes, refactorings, and source actions for a file or position.',
  },
  {
    name: 'rename',
    description:
      'Rename a symbol across the entire workspace. Returns a preview, or applies directly with apply: true.',
  },
  {
    name: 'call_hierarchy',
    description:
      'Get the call hierarchy for a symbol — direction: "incoming" (callers) or "outgoing" (callees).',
  },
  {
    name: 'formatting',
    description:
      'Format a file using the LSP server. Applies formatting edits directly.',
  },
];

export const lspPlugin: DronePlugin = {
  metadata: {
    id: 'lsp',
    name: 'LSP',
    version: '0.2.0',
    description:
      'Adds lightweight language-server diagnostics and semantic queries.',
    defaultEnabled: false,
    dependencies: [{ id: 'persona', optional: true }],
  },
  register: async registration => {
    const personaCap = registration.request<DronePersonaCapability>('persona');
    const runtime = registration.request<{ flags?: RuntimeFlagRegistry }>(
      'runtime'
    );
    runtime?.flags?.append('list-mount', 'lsp');
    const lspConfig = registration.getConfig().lsp;

    const server = createServerManager({
      workspaceRoot: process.cwd(),
      lspConfig,
      logger: registration.logger,
    });

    const lspCache = new ToolMountingCache('lsp');

    // Register diagnostics + server status prompt fragment
    registration.registerPromptFragment({
      key: 'lsp-status',
      phase: 'header',
      render: async () => {
        const diagPrompt = server.renderDiagnosticsPrompt();
        const states = server.getServerStates();
        if (states.length === 0) {
          return diagPrompt;
        }
        const serverLines = states.map(s => `${s.language}: ${s.status}`);
        const serversBlock = `# LSP Servers\n\n${serverLines.join('\n')}`;
        return `${serversBlock}\n\n${diagPrompt}`;
      },
    });

    // Build all tool definitions and add them to the cache
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
      lspCache.addTool(tool.name, tool);
    }

    // ── Meta-tools ──────────────────────────────────────────────────────

    registration.registerTool({
      name: 'list_tools',
      description:
        'List all available LSP tools. Tools include: get_diagnostics, inspect, go_to, find_references, symbols, completion, code_action, rename, call_hierarchy, formatting. Mount the ones you need with lsp__mount_tool.',
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
