import type { DronePlugin } from 'drone-core';

type RuntimeInfo = {
  subagentId?: string;
  persona?: string;
  isSubagent: boolean;
};

export const subagentPlugin: DronePlugin = {
  metadata: {
    id: 'subagent',
    name: 'Subagent Dispatch',
    version: '0.1.0',
    description: 'Enables dispatching subagents for parallel task execution',
    defaultEnabled: true,
  },

  async register(ctx) {
    // Get runtime options to determine mode
    const runtime = ctx.request<RuntimeInfo>('runtime');

    if (runtime?.isSubagent) {
      // === SUBAGENT MODE ===
      // Register only the return tool
      ctx.registerTool({
        name: 'subagent.return',
        description: 'Return the result to the parent agent',
        inputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'The result to send back' },
            error: { type: 'string', description: 'Optional error info' },
          },
          required: ['result'],
          additionalProperties: false,
        },
        execute: async (input) => {
          // Output JSON return event and exit
          const output = {
            type: 'return',
            subagentId: runtime.subagentId,
            result: input.result,
            error: input.error,
          };
          console.log(JSON.stringify(output));
          process.exit(0);
          return JSON.stringify(output);
        },
      });

      ctx.logger.info(`subagent mode: ${runtime.subagentId}`);
    } else {
      // === MAIN AGENT MODE ===
      // Register only the dispatch tool
      ctx.registerTool({
        name: 'subagent.dispatch',
        description: 'Launch a subagent to handle a task in parallel',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The prompt to send to subagent' },
            persona: { type: 'string', description: 'Optional persona' },
            timeout: { type: 'number', description: 'Timeout in ms' },
          },
          required: ['task'],
          additionalProperties: false,
        },
        execute: async (input) => {
          // Phase 2 implementation - return placeholder for now
          return JSON.stringify({ result: 'not implemented' });
        },
      });

      ctx.logger.info('main agent mode: subagent dispatch available');
    }
  },
};