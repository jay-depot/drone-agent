import type { DroneSlashCommand } from 'drone-core';

import type { SwarmMemoryRetriever } from './memory-retrieval.js';

/**
 * `/swarm-memory` control surface: status, forced refresh, and a
 * session-scoped on/off override (runtime suppression without config edits).
 * The refresh callback closes over the conversation window tracker, which
 * lives in the plugin wiring.
 */
export function createSwarmMemoryCommand(
  retriever: SwarmMemoryRetriever
): DroneSlashCommand {
  return {
    command: '/swarm-memory',
    description:
      'Inspect or control proactive swarm-memory retrieval (status | refresh | session-scope on|off)',
    handler: async ctx => {
      const sub = ctx.args[0] ?? 'status';
      if (sub === 'status') {
        ctx.logger.info(retriever.getReport());
        return true;
      }
      if (sub === 'refresh') {
        ctx.logger.info('Forcing swarm-memory refresh…');
        const entries = await retriever.forceRefreshWindow();
        ctx.logger.info(
          `Refresh complete: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} cached.`
        );
        return true;
      }
      if (sub === 'session-scope') {
        const value = ctx.args[1] ?? '';
        if (value === 'off') {
          retriever.setSessionEnabled(false);
          ctx.logger.info(
            'Swarm memory suppressed for this session (config untouched).'
          );
          return true;
        }
        if (value === 'on') {
          retriever.setSessionEnabled(true);
          ctx.logger.info('Swarm memory re-enabled for this session.');
          return true;
        }
        ctx.logger.info('Usage: /swarm-memory session-scope on|off');
        return true;
      }
      ctx.logger.info(
        'Usage: /swarm-memory [status|refresh|session-scope on|off]'
      );
      return true;
    },
  };
}
