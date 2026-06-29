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

export async function registerRoutes(app: FastifyInstance) {
  health(app);
  personas(app);
  skills(app);
  beacons(app);
  knowledge(app);
  insights(app);
  principles(app);
  wiki(app);
  swarm(app);
  messages(app);
}