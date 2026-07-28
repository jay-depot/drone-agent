import type { FastifyInstance } from 'fastify';
import health from './health.js';
import personas from './personas.js';
import skills from './skills.js';
import beacons from './beacons.js';
import knowledge from './knowledge.js';
import insights from './insights.js';
import principles from './principles.js';
import wiki from './wiki.js';
import swarm from './swarm.js';
import messages from './messages.js';
import spawn from './spawn.js';

export async function registerRoutes(app: FastifyInstance) {
  // Health stays at root level (exempted by SPA fallback)
  health(app);

  // All other routes under /api prefix
  await app.register(
    async api => {
      personas(api);
      skills(api);
      beacons(api);
      knowledge(api);
      insights(api);
      principles(api);
      wiki(api);
      swarm(api);
      messages(api);
      spawn(api);
    },
    { prefix: '/api' }
  );
}
