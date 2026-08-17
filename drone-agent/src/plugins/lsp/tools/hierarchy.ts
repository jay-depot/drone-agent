import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeCallHierarchyItem,
  normalizeCallHierarchyCalls,
  callHierarchyItemToLsp,
  type LspCallHierarchyItem,
  type LspCallHierarchyCall,
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
  surroundingText: {
    type: 'string',
    description:
      'Surrounding context text to disambiguate between multiple matches (e.g., "class User {"). Works with text and symbol.',
  },
} as const;

export function createCallHierarchyTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'call_hierarchy',
    description:
      'Get the call hierarchy for a symbol. Use `direction: "incoming"` to see callers leading to this symbol, or `direction: "outgoing"` to see callees invoked by this symbol. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        ...POSITION_PROPERTIES,
        direction: {
          type: 'string',
          enum: ['incoming', 'outgoing'],
          description:
            'Direction of the call hierarchy: "incoming" (callers) or "outgoing" (callees).',
        },
      },
      required: ['filePath', 'direction'],
      additionalProperties: false,
    },
    execute: async input => {
      const direction = input.direction;
      if (direction !== 'incoming' && direction !== 'outgoing') {
        throw new Error(
          'lsp.call_hierarchy requires direction: "incoming" or "outgoing".'
        );
      }
      const toolName = `lsp__call_hierarchy(${direction})`;
      const { runtime, document, line, column } =
        await server.resolveAtPosition(toolName, input);
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
          `lsp.call_hierarchy: no call-hierarchy item at the given position.`
        );
      }
      const method =
        direction === 'incoming'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls';
      const calls = await runtime.client.request<LspCallHierarchyCall[]>(
        method,
        { item: callHierarchyItemToLsp(item) }
      );
      const { from, to } = normalizeCallHierarchyCalls(calls);
      if (direction === 'incoming') {
        return JSON.stringify(
          {
            query: { item, direction },
            from,
          },
          null,
          2
        );
      }
      return JSON.stringify(
        {
          query: { item, direction },
          to,
        },
        null,
        2
      );
    },
  };
}
