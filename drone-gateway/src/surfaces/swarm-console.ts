import { createConsoleRegistry } from '../console/commands.js';
import { parseCommand } from '../console/parse.js';
import type { SurfaceFactory } from './types.js';

export const createSwarmConsoleSurface: SurfaceFactory = (
  _spec,
  conversationId,
  ctx
) => {
  const registry = createConsoleRegistry();

  return {
    id: `swarm-console-${conversationId}`,
    type: 'swarm-console',
    handleMessage: async msg => {
      const line = msg.text.trim();

      if (!line.startsWith('swarm.')) {
        return { response: null, handled: false };
      }

      if (!ctx.swarm) {
        return {
          response:
            'Swarm console requires the coordinator spawn backend (set spawnBackend: "coordinator").',
          handled: true,
        };
      }

      const parsed = parseCommand(line, registry);
      if (!parsed) {
        return { response: null, handled: false };
      }

      const command = registry.get(parsed.name);
      if (!command) {
        return {
          response: `Unknown command "${parsed.name}". Try swarm.help.`,
          handled: true,
        };
      }

      try {
        const response = await command.run({
          positionals: parsed.positionals,
          flags: parsed.flags,
          json: parsed.json,
          api: ctx.swarm,
        });
        return { response, handled: true };
      } catch (err) {
        return {
          response: `Error: ${err instanceof Error ? err.message : String(err)}`,
          handled: true,
        };
      }
    },
  };
};
