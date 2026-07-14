import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeCallHierarchyItem,
  normalizeCallHierarchyCalls,
  callHierarchyItemToLsp,
  type LspCallHierarchyItem,
  type LspCallHierarchyCall,
} from '../normalize/index.js';

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
      },
      required: ['filePath'],
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
      },
      required: ['filePath'],
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
