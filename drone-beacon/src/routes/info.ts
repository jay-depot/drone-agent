import type { FastifyInstance } from 'fastify';
import { getBeaconInfo } from './context.js';

/**
 * Beacon self-description. The swarm plugin fetches this at startup (and on
 * every WS reconnect) so the agent can render the local beacon's name and the
 * coordinator address in its system prompt.
 */
export default function infoRoutes(app: FastifyInstance) {
  app.get('/info', async () => getBeaconInfo());
}
