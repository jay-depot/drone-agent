import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeTextEdits,
  normalizeWorkspaceEdit,
  normalizeCodeActions,
  truncateWorkspaceEdit,
  describeWorkspaceEdit,
  severityToLsp,
  type LspCodeActionResponse,
  type LspWorkspaceEdit,
  type NormalizedWorkspaceEdit,
} from '../normalize/index.js';

const HEAVY_EDIT_BUDGET = 3000;

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
