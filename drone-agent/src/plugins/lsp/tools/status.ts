import type { DroneToolDefinition } from 'drone-core';
import type { ServerManager } from '../server.js';

export function createServerStatusTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'server_status',
    description: 'List LSP server connection state for this session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    execute: async () =>
      JSON.stringify(
        {
          servers: server.getServerStates(),
        },
        null,
        2
      ),
  };
}
