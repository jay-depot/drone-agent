import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  flattenDocumentSymbols,
  normalizeWorkspaceSymbols,
  type LspDocumentSymbolResponse,
  type LspWorkspaceSymbolResponse,
  type NormalizedSymbol,
} from '../normalize/index.js';

export function createDocumentSymbolsTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'document_symbols',
    description:
      'Return the symbols defined in a single file (functions, classes, variables, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    execute: async input => {
      if (
        typeof input.filePath !== 'string' ||
        input.filePath.trim().length === 0
      ) {
        throw new Error('lsp.document_symbols requires a filePath string.');
      }
      await server.refreshIfNeeded();
      const filePath = server.resolveTargetFilePath(input.filePath);
      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }
      const document = await server.ensureDocumentLoaded(runtime, filePath);
      const response = await runtime.client.request<
        LspDocumentSymbolResponse[]
      >('textDocument/documentSymbol', { textDocument: { uri: document.uri } });
      const symbols = flattenDocumentSymbols(response);
      return JSON.stringify(
        {
          query: { filePath },
          symbols,
          serverStates: server.getServerStates(),
        },
        null,
        2
      );
    },
  };
}

export function createWorkspaceSymbolTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'workspace_symbol',
    description:
      'Search for symbols across the workspace by name. Supports fuzzy matching where the language server supports it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Symbol name (or substring) to search for. Empty string returns all symbols.',
        },
        limit: {
          type: 'integer',
          description: 'Optional maximum number of results. Defaults to 200.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async input => {
      if (typeof input.query !== 'string') {
        throw new Error('lsp.workspace_symbol requires a query string.');
      }
      await server.refreshIfNeeded();
      const limit =
        typeof input.limit === 'number' &&
        Number.isInteger(input.limit) &&
        input.limit > 0
          ? Math.min(input.limit, 1000)
          : 200;
      const allResults: Array<{
        serverId: string;
        symbols: NormalizedSymbol[];
      }> = [];
      const serverStates = server.getServerStates();
      for (const state of serverStates) {
        if (state.status !== 'connected') {
          continue;
        }
        const runtime = server.findRuntimeForFile(
          `dummy${state.language === 'typescript' ? '.ts' : '.js'}`
        );
        if (!runtime) {
          continue;
        }
        try {
          const response = await runtime.client.request<
            LspWorkspaceSymbolResponse[]
          >('workspace/symbol', { query: input.query });
          const symbols = normalizeWorkspaceSymbols(response);
          if (symbols.length > 0) {
            allResults.push({
              serverId: runtime.id,
              symbols,
            });
          }
        } catch {
          // Ignore individual server failures.
        }
      }
      const flat = allResults.flatMap(group =>
        group.symbols.map(symbol => ({
          ...symbol,
          serverId: group.serverId,
        }))
      );
      flat.sort((left, right) => left.name.localeCompare(right.name));
      const truncated = flat.length > limit;
      const symbols = truncated ? flat.slice(0, limit) : flat;
      return JSON.stringify(
        {
          query: input.query,
          symbols,
          truncated,
          totalMatches: flat.length,
          serverStates,
        },
        null,
        2
      );
    },
  };
}
