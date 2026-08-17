import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeLspLocation,
  type DefinitionResponse,
  type ReferencesResponse,
} from '../normalize/index.js';

const AUTO_EXPANSION_LIMIT = 5;
const SNIPPET_CONTEXT_LINES = 5;

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

async function buildAutoExpansion(
  server: ServerManager,
  locations: Array<{
    filePath: string;
    line: number;
    column: number;
  }>
): Promise<Record<string, string>> {
  if (locations.length === 0 || locations.length > AUTO_EXPANSION_LIMIT) {
    return {};
  }
  const snippets: Record<string, string> = {};
  const seenFiles = new Set<string>();
  for (const loc of locations) {
    const key = `${loc.filePath}:${loc.line}:${loc.column}`;
    if (seenFiles.has(loc.filePath)) {
      continue;
    }
    seenFiles.add(loc.filePath);
    try {
      const snippet = await server.readFileSnippet(
        loc.filePath,
        loc.line,
        SNIPPET_CONTEXT_LINES
      );
      if (snippet) {
        snippets[key] = snippet;
      }
    } catch {
      // Skip files that can't be read
    }
  }
  return snippets;
}

export function createGoToTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'go_to',
    description:
      'Navigate to a symbol\'s definition, type definition, or implementation. Use `kind: "definition"` (default) to find where a symbol is defined, `kind: "type"` to find its type definition, or `kind: "implementation"` to find implementations of an interface or method. Supports `text` and `symbol` parameters for position resolution. When the result set is small (≤5 locations), code snippets are automatically included.',
    inputSchema: {
      type: 'object',
      properties: {
        ...POSITION_PROPERTIES,
        kind: {
          type: 'string',
          enum: ['definition', 'type', 'implementation'],
          description:
            'Navigation kind: "definition" (default), "type", or "implementation".',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const kind = typeof input.kind === 'string' ? input.kind : 'definition';
      const toolName = `lsp__go_to(${kind})`;
      const { runtime, document, line, column } =
        await server.resolveAtPosition(toolName, input);

      const method =
        kind === 'type'
          ? 'textDocument/typeDefinition'
          : kind === 'implementation'
            ? 'textDocument/implementation'
            : 'textDocument/definition';

      const response = await runtime.client.request<DefinitionResponse>(
        method,
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
      const agentLocations = server.locationToAgentShape(locations);

      const result: Record<string, unknown> = {
        query: { filePath: document.uri, line, column, kind },
        locations: agentLocations,
      };

      const snippets = await buildAutoExpansion(server, agentLocations);
      if (Object.keys(snippets).length > 0) {
        result.snippets = snippets;
      }

      return JSON.stringify(result, null, 2);
    },
  };
}

export function createFindReferencesTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'find_references',
    description:
      'Find all references to a symbol across the workspace. Use this to see everywhere a symbol is used. Supports `text` and `symbol` parameters for position resolution. When the result set is small (≤5 locations), code snippets are automatically included.',
    inputSchema: {
      type: 'object',
      properties: {
        ...POSITION_PROPERTIES,
        includeDeclaration: {
          type: 'boolean',
          description:
            'Whether declaration sites should be included in the results. Defaults to true.',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    execute: async input => {
      await server.refreshIfNeeded();
      const { filePath, line, column } = await server.parsePositionInput(
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

      const agentLocations = server.locationToAgentShape(locations);

      const result: Record<string, unknown> = {
        query: {
          filePath,
          line,
          column,
          includeDeclaration,
        },
        locations: agentLocations,
      };

      const snippets = await buildAutoExpansion(server, agentLocations);
      if (Object.keys(snippets).length > 0) {
        result.snippets = snippets;
      }

      return JSON.stringify(result, null, 2);
    },
  };
}
