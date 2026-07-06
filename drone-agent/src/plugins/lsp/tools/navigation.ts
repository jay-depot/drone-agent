import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';
import {
  normalizeHoverContents,
  normalizeLspRange,
  normalizeLspLocation,
  type HoverResponse,
  type DefinitionResponse,
  type ReferencesResponse,
} from '../normalize/index.js';

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
