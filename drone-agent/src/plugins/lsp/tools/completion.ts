import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeHoverContents,
  normalizeLspRange,
  normalizeSignatureHelp,
  normalizeCompletionItems,
  type HoverResponse,
  type LspSignatureHelpResponse,
  type LspCompletionItemResponse,
  type LspCompletionListResponse,
} from '../normalize/index.js';

const POSITION_PROPERTIES = {
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
    description: 'Symbol name to resolve (alternative to line/column).',
  },
} as const;

export function createInspectTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'inspect',
    description:
      'Inspect a symbol at a position. Returns hover information (type, documentation) and signature help (active parameter info for function calls) in a single response. Use this to understand what a symbol is, its type, or what parameters a function expects. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      properties: POSITION_PROPERTIES,
      required: ['filePath'],
      additionalProperties: false,
    },
    execute: async input => {
      const { runtime, document, line, column } =
        await server.resolveAtPosition('lsp__inspect', input);

      const [hoverResponse, signatureResponse] = await Promise.all([
        runtime.client.request<HoverResponse>('textDocument/hover', {
          textDocument: { uri: document.uri },
          position: { line: line - 1, character: column - 1 },
        }),
        runtime.client.request<LspSignatureHelpResponse>(
          'textDocument/signatureHelp',
          {
            textDocument: { uri: document.uri },
            position: { line: line - 1, character: column - 1 },
          }
        ),
      ]);

      const contents = normalizeHoverContents(hoverResponse?.contents);
      const signatures = normalizeSignatureHelp(signatureResponse);

      return JSON.stringify(
        {
          query: { filePath: document.uri, line, column },
          hover: {
            contents,
            range: hoverResponse?.range
              ? normalizeLspRange(hoverResponse.range)
              : undefined,
          },
          signatures,
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
      'Get completion suggestions at a position. Includes kind, detail, and documentation. Use this to see what identifiers, methods, or properties are available at a cursor position. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        ...POSITION_PROPERTIES,
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
