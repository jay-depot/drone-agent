import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from './server.js';
import {
  normalizeHoverContents,
  normalizeLspRange,
  normalizeLspLocation,
  normalizeSignatureHelp,
  normalizeCompletionItems,
  normalizeCodeActions,
  normalizeWorkspaceEdit,
  normalizeCallHierarchyItem,
  normalizeCallHierarchyCalls,
  flattenDocumentSymbols,
  normalizeWorkspaceSymbols,
  normalizeTextEdits,
  truncateWorkspaceEdit,
  describeWorkspaceEdit,
  severityToLsp,
  callHierarchyItemToLsp,
  type HoverResponse,
  type DefinitionResponse,
  type ReferencesResponse,
  type LspDocumentSymbolResponse,
  type LspWorkspaceSymbolResponse,
  type LspSignatureHelpResponse,
  type LspCompletionItemResponse,
  type LspCompletionListResponse,
  type LspCodeActionResponse,
  type LspWorkspaceEdit,
  type LspCallHierarchyCall,
  type LspCallHierarchyItem,
  type NormalizedWorkspaceEdit,
  type NormalizedSymbol,
} from './normalize.js';

const HEAVY_EDIT_BUDGET = 3000;

// ---------------------------------------------------------------------------
// Tool: get_diagnostics
// ---------------------------------------------------------------------------

export function createGetDiagnosticsTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'get_diagnostics',
    description:
      'Return the current LSP diagnostics for the workspace or a specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Optional file path to filter diagnostics to a specific file.',
        },
        severity: {
          type: 'string',
          description:
            'Optional severity filter: error, warning, information, hint, or all.',
        },
      },
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const severity =
        typeof input.severity === 'string'
          ? input.severity.toLowerCase()
          : 'all';
      if (
        !['all', 'error', 'warning', 'information', 'hint'].includes(severity)
      ) {
        throw new Error(
          'lsp.get_diagnostics severity must be one of: all, error, warning, information, hint.'
        );
      }

      const filePath =
        typeof input.filePath === 'string'
          ? server.resolveTargetFilePath(input.filePath)
          : undefined;
      const diagnostics = server.getDiagnostics().filter(diagnostic => {
        if (filePath && diagnostic.filePath !== filePath) {
          return false;
        }
        if (severity !== 'all' && diagnostic.severity !== severity) {
          return false;
        }
        return true;
      });

      return JSON.stringify(
        {
          diagnostics,
          serverStates: server.getServerStates(),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: hover
// ---------------------------------------------------------------------------

export function createHoverTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'hover',
    description:
      'Return LSP hover information for a symbol at a file, line, and column.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const { filePath, line, column } = server.parsePositionInput(
        'lsp__hover',
        input
      );
      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }

      const document = await server.ensureDocumentLoaded(runtime, filePath);
      const response = await runtime.client.request<HoverResponse>(
        'textDocument/hover',
        {
          textDocument: {
            uri: document.uri,
          },
          position: {
            line: line - 1,
            character: column - 1,
          },
        }
      );
      const contents = normalizeHoverContents(response?.contents);
      const result = {
        filePath,
        line,
        column,
        contents,
        range: response?.range ? normalizeLspRange(response.range) : undefined,
      };

      return JSON.stringify(result, null, 2);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: go_to_definition
// ---------------------------------------------------------------------------

export function createGoToDefinitionTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'go_to_definition',
    description:
      'Resolve the definition location(s) for a symbol at a file, line, and column.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const { filePath, line, column } = server.parsePositionInput(
        'lsp__go_to_definition',
        input
      );
      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }

      const document = await server.ensureDocumentLoaded(runtime, filePath);
      const definition = await runtime.client.request<DefinitionResponse>(
        'textDocument/definition',
        {
          textDocument: {
            uri: document.uri,
          },
          position: {
            line: line - 1,
            character: column - 1,
          },
        }
      );

      const rawLocations = Array.isArray(definition)
        ? definition
        : definition
          ? [definition]
          : [];
      const locations = rawLocations
        .map(location => normalizeLspLocation(location))
        .filter((location): location is NonNullable<typeof location> =>
          Boolean(location)
        );

      return JSON.stringify(
        {
          query: {
            filePath,
            line,
            column,
          },
          locations: server.locationToAgentShape(locations),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: find_references
// ---------------------------------------------------------------------------

export function createFindReferencesTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'find_references',
    description:
      'Find references to a symbol at a file, line, and column, optionally excluding declarations.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
        includeDeclaration: {
          type: 'boolean',
          description:
            'Whether declaration sites should be included in the results. Defaults to true.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const { filePath, line, column } = server.parsePositionInput(
        'lsp__find_references',
        input
      );
      const includeDeclaration =
        typeof input.includeDeclaration === 'boolean'
          ? input.includeDeclaration
          : true;

      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }

      const document = await server.ensureDocumentLoaded(runtime, filePath);
      const references = await runtime.client.request<ReferencesResponse>(
        'textDocument/references',
        {
          textDocument: {
            uri: document.uri,
          },
          position: {
            line: line - 1,
            character: column - 1,
          },
          context: {
            includeDeclaration,
          },
        }
      );

      const locations = (references ?? [])
        .map(location => normalizeLspLocation(location))
        .filter((location): location is NonNullable<typeof location> =>
          Boolean(location)
        );

      return JSON.stringify(
        {
          query: {
            filePath,
            line,
            column,
            includeDeclaration,
          },
          locations: server.locationToAgentShape(locations),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: document_symbols
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool: workspace_symbol
// ---------------------------------------------------------------------------

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
      // We need access to serverRuntimes for workspace_symbol since it queries all servers.
      // The server manager doesn't expose this directly, so we use getServerStates for metadata
      // and iterate through connected servers via the tool's own logic.
      // For now, we use the server's getServerStates to know which servers exist.
      const serverStates = server.getServerStates();
      for (const state of serverStates) {
        if (state.status !== 'connected') {
          continue;
        }
        // We need the runtime client to make the request. The server manager
        // doesn't expose runtimes directly, so we find a file for this server's
        // language and use that runtime.
        // This is a limitation — workspace_symbol should ideally iterate all runtimes.
        // For now, we query the first connected server that matches any file extension.
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

// ---------------------------------------------------------------------------
// Tool: signature_help
// ---------------------------------------------------------------------------

export function createSignatureHelpTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'signature_help',
    description:
      'Return LSP signature help for the function call at a given position.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__signature_help', input);
      const response = await runtime.client.request<LspSignatureHelpResponse>(
        'textDocument/signatureHelp',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }
      );
      const signatures = normalizeSignatureHelp(response);
      return JSON.stringify(
        {
          query: { filePath: document.uri, line, column },
          ...signatures,
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: completion
// ---------------------------------------------------------------------------

export function createCompletionTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'completion',
    description:
      'Return LSP completion suggestions at a given position. Includes kind, detail, and documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
        limit: {
          type: 'integer',
          description:
            'Optional maximum number of items to return. Defaults to 100.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__completion', input);
      const limit =
        typeof input.limit === 'number' &&
        Number.isInteger(input.limit) &&
        input.limit > 0
          ? Math.min(input.limit, 1000)
          : 100;
      const response = await runtime.client.request<
        LspCompletionItemResponse[] | LspCompletionListResponse
      >('textDocument/completion', {
        textDocument: { uri: document.uri },
        position: { line: line - 1, character: column - 1 },
      });
      const { isIncomplete, items } = normalizeCompletionItems(response);
      const truncated = items.length > limit;
      const resultItems = truncated ? items.slice(0, limit) : items;
      return JSON.stringify(
        {
          query: { filePath: document.uri, line, column },
          isIncomplete,
          items: resultItems,
          truncated,
          totalItems: items.length,
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: code_action
// ---------------------------------------------------------------------------

export function createCodeActionTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'code_action',
    description:
      'Return LSP code actions (quick fixes, refactorings, source actions) for a file and range. Returns edits as JSON; the LSP plugin never applies them. The agent should review and apply via file.write.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        startLine: {
          type: 'integer',
          description: '1-based start line of the range.',
        },
        startColumn: {
          type: 'integer',
          description: '1-based start column of the range.',
        },
        endLine: {
          type: 'integer',
          description: '1-based end line of the range.',
        },
        endColumn: {
          type: 'integer',
          description: '1-based end column of the range.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of LSP CodeActionKind values to filter by, e.g. ["quickfix", "refactor", "source.fixAll"].',
        },
      },
      required: [
        'filePath',
        'startLine',
        'startColumn',
        'endLine',
        'endColumn',
      ],
      additionalProperties: false,
    },
    execute: async input => {
      const startLine = input.startLine;
      const startColumn = input.startColumn;
      const endLine = input.endLine;
      const endColumn = input.endColumn;
      if (
        typeof startLine !== 'number' ||
        !Number.isInteger(startLine) ||
        startLine <= 0 ||
        typeof startColumn !== 'number' ||
        !Number.isInteger(startColumn) ||
        startColumn <= 0 ||
        typeof endLine !== 'number' ||
        !Number.isInteger(endLine) ||
        endLine <= 0 ||
        typeof endColumn !== 'number' ||
        !Number.isInteger(endColumn) ||
        endColumn <= 0
      ) {
        throw new Error(
          'lsp.code_action requires positive integer line/column values for the range.'
        );
      }
      await server.refreshIfNeeded();
      if (
        typeof input.filePath !== 'string' ||
        input.filePath.trim().length === 0
      ) {
        throw new Error('lsp.code_action requires a filePath string.');
      }
      const filePath = server.resolveTargetFilePath(input.filePath);
      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }
      const document = await server.ensureDocumentLoaded(runtime, filePath);
      const only = Array.isArray(input.only)
        ? input.only.filter(
            (value): value is string => typeof value === 'string'
          )
        : undefined;
      const range = {
        start: {
          line: startLine - 1,
          character: startColumn - 1,
        },
        end: {
          line: endLine - 1,
          character: endColumn - 1,
        },
      };
      // Include any diagnostics touching this range so the server can
      // surface relevant quick-fixes.
      const diagnostics = server.getDiagnostics().filter(diagnostic => {
        const ds = diagnostic.range.start;
        const de = diagnostic.range.end;
        if (
          ds.line > range.end.line ||
          (ds.line === range.end.line && ds.character > range.end.character)
        ) {
          return false;
        }
        if (
          de.line < range.start.line ||
          (de.line === range.start.line && de.character < range.start.character)
        ) {
          return false;
        }
        return true;
      });
      const response = await runtime.client.request<LspCodeActionResponse[]>(
        'textDocument/codeAction',
        {
          textDocument: { uri: document.uri },
          range,
          context: {
            diagnostics: diagnostics.map(diagnostic => ({
              range: diagnostic.range,
              message: diagnostic.message,
              severity: severityToLsp(diagnostic.severity),
              source: diagnostic.source,
              code: diagnostic.code,
            })),
            only,
          },
        }
      );
      const actions = normalizeCodeActions(response);
      const result = actions.map(action => {
        const edit = action.edit;
        if (!edit) {
          return {
            title: action.title,
            kind: action.kind,
            isPreferred: action.isPreferred,
            disabledReason: action.disabledReason,
            requiresServerCommand: action.requiresServerCommand,
            command: action.command,
            edit: null,
          };
        }
        const truncated = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
        return {
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          disabledReason: action.disabledReason,
          requiresServerCommand: action.requiresServerCommand,
          command: action.command,
          edit: truncated,
          summary: describeWorkspaceEdit(edit),
        };
      });
      return JSON.stringify(
        {
          query: { filePath, startLine, startColumn, endLine, endColumn },
          actions: result,
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: rename
// ---------------------------------------------------------------------------

export function createRenameTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'rename',
    description:
      'Return the WorkspaceEdit for renaming a symbol across the workspace. Edits are returned as JSON only — the LSP plugin never applies them. The agent should review and apply via file.write.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
        newName: {
          type: 'string',
          description: 'The new symbol name.',
        },
      },
      required: ['filePath', 'line', 'column', 'newName'],
      additionalProperties: false,
    },
    execute: async input => {
      if (typeof input.newName !== 'string' || input.newName.length === 0) {
        throw new Error('lsp.rename requires a non-empty newName.');
      }
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__rename', input);
      const response = await runtime.client.request<LspWorkspaceEdit>(
        'textDocument/rename',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
          newName: input.newName,
        }
      );
      const edit = normalizeWorkspaceEdit(response);
      const truncated = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
      return JSON.stringify(
        {
          query: {
            filePath: document.uri,
            line,
            column,
            newName: input.newName,
          },
          edit: truncated,
          summary: describeWorkspaceEdit(edit),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: implementation
// ---------------------------------------------------------------------------

export function createImplementationTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'implementation',
    description:
      'Return locations that implement the interface or method at a position.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__implementation', input);
      const response = await runtime.client.request<DefinitionResponse>(
        'textDocument/implementation',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }
      );
      const rawLocations = Array.isArray(response)
        ? response
        : response
          ? [response]
          : [];
      const locations = rawLocations
        .map(loc => normalizeLspLocation(loc))
        .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc));
      return JSON.stringify(
        {
          query: { filePath: document.uri, line, column },
          locations: server.locationToAgentShape(locations),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: type_definition
// ---------------------------------------------------------------------------

export function createTypeDefinitionTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'type_definition',
    description:
      'Return the type-definition location(s) for a symbol at a position.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__type_definition', input);
      const response = await runtime.client.request<DefinitionResponse>(
        'textDocument/typeDefinition',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }
      );
      const rawLocations = Array.isArray(response)
        ? response
        : response
          ? [response]
          : [];
      const locations = rawLocations
        .map(loc => normalizeLspLocation(loc))
        .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc));
      return JSON.stringify(
        {
          query: { filePath: document.uri, line, column },
          locations: server.locationToAgentShape(locations),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: call_hierarchy_incoming
// ---------------------------------------------------------------------------

export function createCallHierarchyIncomingTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'call_hierarchy_incoming',
    description:
      'Return the call hierarchy chain of callers leading to the symbol at a position.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__call_hierarchy_incoming', input);
      const response = await runtime.client.request<LspCallHierarchyItem[]>(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }
      );
      const item = normalizeCallHierarchyItem(response?.[0]);
      if (!item) {
        throw new Error(
          'lsp.call_hierarchy_incoming: no call-hierarchy item at the given position.'
        );
      }
      const calls = await runtime.client.request<LspCallHierarchyCall[]>(
        'callHierarchy/incomingCalls',
        { item: callHierarchyItemToLsp(item) }
      );
      const { from } = normalizeCallHierarchyCalls(calls);
      return JSON.stringify(
        {
          query: { item, direction: 'incoming' },
          from,
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: call_hierarchy_outgoing
// ---------------------------------------------------------------------------

export function createCallHierarchyOutgoingTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'call_hierarchy_outgoing',
    description:
      'Return the call hierarchy chain of callees invoked by the symbol at a position.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description: '1-based line number.',
        },
        column: {
          type: 'integer',
          description: '1-based column number.',
        },
      },
      required: ['filePath', 'line', 'column'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__call_hierarchy_outgoing', input);
      const response = await runtime.client.request<LspCallHierarchyItem[]>(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }
      );
      const item = normalizeCallHierarchyItem(response?.[0]);
      if (!item) {
        throw new Error(
          'lsp.call_hierarchy_outgoing: no call-hierarchy item at the given position.'
        );
      }
      const calls = await runtime.client.request<LspCallHierarchyCall[]>(
        'callHierarchy/outgoingCalls',
        { item: callHierarchyItemToLsp(item) }
      );
      const { to } = normalizeCallHierarchyCalls(calls);
      return JSON.stringify(
        {
          query: { item, direction: 'outgoing' },
          to,
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: formatting
// ---------------------------------------------------------------------------

export function createFormattingTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'formatting',
    description:
      'Return LSP whole-file formatting edits for a single file. Returns edits as JSON; the LSP plugin never applies them. If the response would be too large it is truncated with head/tail previews per edit.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        tabSize: {
          type: 'integer',
          description: 'Optional tab size hint forwarded to the server.',
        },
        insertSpaces: {
          type: 'boolean',
          description: 'Optional space-vs-tabs hint forwarded to the server.',
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
        throw new Error('lsp.formatting requires a filePath string.');
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
      const options: {
        tabSize?: number;
        insertSpaces?: boolean;
      } = {};
      if (
        typeof input.tabSize === 'number' &&
        Number.isInteger(input.tabSize) &&
        input.tabSize > 0
      ) {
        options.tabSize = input.tabSize;
      }
      if (typeof input.insertSpaces === 'boolean') {
        options.insertSpaces = input.insertSpaces;
      }
      const response = await runtime.client.request<
        Array<{
          range?: {
            start?: { line?: number; character?: number };
            end?: { line?: number; character?: number };
          };
          newText?: string;
        }>
      >('textDocument/formatting', {
        textDocument: { uri: document.uri },
        options,
      });
      const edits = normalizeTextEdits(response);
      const wrapped: NormalizedWorkspaceEdit = {
        changes: [{ filePath, edits }],
        documentChanges: [],
      };
      const truncated = truncateWorkspaceEdit(wrapped, HEAVY_EDIT_BUDGET);
      return JSON.stringify(
        {
          query: { filePath },
          edit: truncated,
          summary: describeWorkspaceEdit(wrapped),
        },
        null,
        2
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: server_status
// ---------------------------------------------------------------------------

export function createServerStatusTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'server_status',
    description: 'List LSP server connection state for this session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    execute: async () =>
      JSON.stringify(
        {
          servers: server.getServerStates(),
        },
        null,
        2
      ),
  };
}
