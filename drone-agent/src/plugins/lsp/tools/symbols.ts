import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  flattenDocumentSymbols,
  normalizeWorkspaceSymbols,
  type LspDocumentSymbolResponse,
  type LspWorkspaceSymbolResponse,
  type NormalizedSymbol,
} from '../normalize/index.js';

export function createSymbolsTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'symbols',
    description:
      'List symbols in a file or search across the workspace. Use `scope: "document"` to list all symbols in a specific file (functions, classes, variables), or `scope: "workspace"` to search for symbols by name across the entire workspace with fuzzy matching.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['document', 'workspace'],
          description:
            'Search scope: "document" for a single file, "workspace" for cross-workspace search.',
        },
        filePath: {
          type: 'string',
          description: 'File path (required when scope is "document").',
        },
        query: {
          type: 'string',
          description:
            'Symbol name or substring to search for (required when scope is "workspace"). Empty string returns all symbols.',
        },
        limit: {
          type: 'integer',
          description:
            'Optional max results (workspace scope only, default 200).',
        },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    execute: async input => {
      const scope = input.scope;
      if (scope === 'document') {
        return executeDocumentSymbols(server, input);
      }
      return executeWorkspaceSymbols(server, input);
    },
  };
}

async function executeDocumentSymbols(
  server: ServerManager,
  input: Record<string, unknown>
): Promise<string> {
  if (
    typeof input.filePath !== 'string' ||
    input.filePath.trim().length === 0
  ) {
    throw new Error(
      'lsp.symbols (scope: "document") requires a filePath string.'
    );
  }
  await server.refreshIfNeeded();
  const filePath = server.resolveTargetFilePath(input.filePath);
  const runtime = server.findRuntimeForFile(filePath);
  if (!runtime) {
    throw new Error(`No connected LSP server is available for ${filePath}.`);
  }
  const document = await server.ensureDocumentLoaded(runtime, filePath);
  const response = await runtime.client.request<LspDocumentSymbolResponse[]>(
    'textDocument/documentSymbol',
    { textDocument: { uri: document.uri } }
  );
  const symbols = flattenDocumentSymbols(response);
  return JSON.stringify(
    {
      query: { filePath, scope: 'document' },
      symbols,
      serverStates: server.getServerStates(),
    },
    null,
    2
  );
}

async function executeWorkspaceSymbols(
  server: ServerManager,
  input: Record<string, unknown>
): Promise<string> {
  if (typeof input.query !== 'string') {
    throw new Error(
      'lsp.symbols (scope: "workspace") requires a query string.'
    );
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
      scope: 'workspace',
      symbols,
      truncated,
      totalMatches: flat.length,
      serverStates,
    },
    null,
    2
  );
}
