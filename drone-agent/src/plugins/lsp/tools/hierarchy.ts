import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeCallHierarchyItem,
  normalizeCallHierarchyCalls,
  callHierarchyItemToLsp,
  normalizeLspLocation,
  type LspCallHierarchyItem,
  type LspCallHierarchyCall,
  type ReferencesResponse,
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

const REFERENCES_CAP = 50;

export function createCallHierarchyTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'call_hierarchy',
    description:
      'Get the call hierarchy for a symbol. Use `direction: "incoming"` to see callers leading to this symbol, or `direction: "outgoing"` to see callees invoked by this symbol. Supports `text`, `symbol`, and `surroundingText` parameters for position resolution. When the hierarchy result is empty, the tool cross-checks against `textDocument/references` and, if references are found, includes a `warning` plus a `references` field so you can tell an empty-but-referenced result apart from a genuinely unreferenced symbol.',
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
      await server.refreshIfNeeded();
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
      const result: Record<string, unknown> = {
        query: { item, direction },
      };
      if (direction === 'incoming') {
        result.from = from;
      } else {
        result.to = to;
      }

      // The hierarchy result for the requested direction is empty. Some LSP
      // servers (notably typescript-language-server) return no callers/callees
      // for local functions even when they exist, so cross-check against
      // references to avoid reporting a misleading empty result.
      const hierarchyResult = direction === 'incoming' ? from : to;
      if (hierarchyResult.length === 0) {
        const references = await runtime.client.request<ReferencesResponse>(
          'textDocument/references',
          {
            textDocument: { uri: document.uri },
            position: { line: line - 1, character: column - 1 },
            context: { includeDeclaration: false },
          }
        );
        const locations = (references ?? [])
          .map(location => normalizeLspLocation(location))
          .filter((location): location is NonNullable<typeof location> =>
            Boolean(location)
          );
        const agentLocations = server.locationToAgentShape(locations);
        const deduped = dedupeLocations(agentLocations).slice(
          0,
          REFERENCES_CAP
        );
        if (deduped.length > 0) {
          result.warning = `callHierarchy/${method} returned no ${
            direction === 'incoming' ? 'callers' : 'callees'
          }, but textDocument/references found ${deduped.length} reference${
            deduped.length === 1 ? '' : 's'
          } — the hierarchy result may be incomplete. See "references".`;
          result.references = deduped;
        }
      }

      return JSON.stringify(result, null, 2);
    },
  };
}

function dedupeLocations(
  locations: Array<{
    filePath: string;
    line: number;
    column: number;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }>
): typeof locations {
  const seen = new Set<string>();
  const out: typeof locations = [];
  for (const location of locations) {
    const key = `${location.filePath}:${location.line}:${location.column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(location);
  }
  return out;
}
