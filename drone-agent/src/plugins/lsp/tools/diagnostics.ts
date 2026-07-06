import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';

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
