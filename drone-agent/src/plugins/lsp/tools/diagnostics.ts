import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';

export function createGetDiagnosticsTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'get_diagnostics',
    description:
      'Return the current LSP diagnostics for the workspace or a specific file. Use text or symbol to filter diagnostics near a specific position.',
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
        text: {
          type: 'string',
          description:
            'Text content to find diagnostics near (alternative to filePath-only filtering).',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to find diagnostics near (alternative to filePath-only filtering).',
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

      // Resolve target position from text/symbol if provided
      let targetPosition: { line: number; column: number } | undefined;
      if (typeof input.text === 'string' || typeof input.symbol === 'string') {
        const resolved = await server.parsePositionInput(
          'lsp__get_diagnostics',
          input
        );
        targetPosition = { line: resolved.line, column: resolved.column };
      }

      const diagnostics = server.getDiagnostics().filter(diagnostic => {
        if (filePath && diagnostic.filePath !== filePath) {
          return false;
        }
        if (severity !== 'all' && diagnostic.severity !== severity) {
          return false;
        }
        if (targetPosition) {
          // Only include diagnostics whose range contains the target position
          const ds = diagnostic.range.start;
          const de = diagnostic.range.end;
          if (
            targetPosition.line - 1 < ds.line ||
            (targetPosition.line - 1 === ds.line &&
              targetPosition.column - 1 < ds.character)
          ) {
            return false;
          }
          if (
            targetPosition.line - 1 > de.line ||
            (targetPosition.line - 1 === de.line &&
              targetPosition.column - 1 > de.character)
          ) {
            return false;
          }
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
