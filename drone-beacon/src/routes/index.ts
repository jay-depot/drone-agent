import type { FastifyInstance } from 'fastify';
import health from './health.js';
import personas from './personas.js';
import skills from './skills.js';
import agents from './agents.js';
import memory from './memory.js';
import messages from './messages.js';
import spawn from './spawn.js';
import config from './config.js';
import events from './events.js';
import insights from './insights.js';
import principles from './principles.js';
import wiki from './wiki.js';
import sync from './sync.js';

// Re-export helpers from context for external use
export {
  setCoordinatorClient,
  setBeaconAddress,
  triggerCoordinatorSync,
} from './context.js';

export async function registerRoutes(app: FastifyInstance) {
  health(app);
  personas(app);
  skills(app);
  agents(app);
  memory(app);
  messages(app);
  spawn(app);
  config(app);
  events(app);
  insights(app);
  principles(app);
  wiki(app);
  sync(app);
}