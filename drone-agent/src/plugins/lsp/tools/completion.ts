import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeSignatureHelp,
  normalizeCompletionItems,
  type LspSignatureHelpResponse,
  type LspCompletionItemResponse,
  type LspCompletionListResponse,
} from '../normalize/index.js';

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
          description:
            '1-based line number (optional if text or symbol is provided).',
        },
        column: {
          type: 'integer',
          description:
            '1-based column number (optional if text or symbol is provided).',
        },
        text: {
          type: 'string',
          description:
            'Text content to search for in the file (alternative to line/column).',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to resolve (alternative to line/column).',
        },
      },
      required: ['filePath'],
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
          description:
            '1-based line number (optional if text or symbol is provided).',
        },
        column: {
          type: 'integer',
          description:
            '1-based column number (optional if text or symbol is provided).',
        },
        text: {
          type: 'string',
          description:
            'Text content to search for in the file (alternative to line/column).',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to resolve (alternative to line/column).',
        },
        limit: {
          type: 'integer',
          description:
            'Optional maximum number of items to return. Defaults to 100.',
        },
      },
      required: ['filePath'],
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
