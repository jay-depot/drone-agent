import * as db from './db/index.js';
import { getCoordinatorClient } from './routes/context.js';
import { logger } from './logger.js';
import type { AgentSession } from './types.js';

export interface RemoveAgentResult {
  /** True when a row was deleted. */
  removed: boolean;
  /** The row as it was before deletion, or undefined when no row existed. */
  agent: AgentSession | undefined;
}

/**
 * Delete one agent row and report the loss.
 *
 * This is the one path that removes an agent. The `DELETE /agents/:id` route
 * and the stale-agent reaper both call it. It reports the end to the
 * coordinator and writes the event log. It does NOT fire the session-end hook:
 * the hook spawns an ingest agent, and the reaper must never cause a spawn
 * storm.
 */
export async function removeAgent(agentId: string): Promise<RemoveAgentResult> {
  const agent = db.getAgent(agentId);
  if (!agent) return { removed: false, agent: undefined };

  const connectedAt = agent.connectedAt;
  const removed = db.unregisterAgent(agentId);
  if (!removed) return { removed: false, agent };

  const client = getCoordinatorClient();
  if (client) {
    client.endSession(agentId, connectedAt).catch(err => {
      logger.warn(`Failed to sync session end to coordinator: ${err}`);
    });
  }

  db.createEventLog({
    eventType: 'agent.disconnected',
    agentId,
    metadata: { connectedAt, durationMs: Date.now() - connectedAt },
  });

  return { removed: true, agent };
}
