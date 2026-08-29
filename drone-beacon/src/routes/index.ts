import type { FastifyInstance } from 'fastify';
import health from './health.js';
import search from './search.js';
import personas from './personas.js';
import skills from './skills.js';
import agents from './agents.js';
import channels from './channels.js';
import memory from './memory.js';
import messages from './messages.js';
import spawn from './spawn.js';
import config from './config.js';
import events from './events.js';
import fragments from './fragments.js';
import insights from './insights.js';
import principles from './principles.js';
import wiki from './wiki.js';
import sync from './sync.js';
import sessions from './sessions.js';
import coordinatorTrust from './coordinator-trust.js';
import coordinator from './coordinator.js';

// Re-export helpers from context for external use
export {
  setCoordinatorClient,
  setSearchIndexer,
  setBeaconAddress,
  triggerCoordinatorSync,
} from './context.js';

export async function registerRoutes(app: FastifyInstance) {
  health(app);
  personas(app);
  skills(app);
  channels(app);
  search(app);
  agents(app);
  memory(app);
  messages(app);
  spawn(app);
  config(app);
  events(app);
  fragments(app);
  insights(app);
  principles(app);
  wiki(app);
  sync(app);
  sessions(app);
  coordinatorTrust(app);
  coordinator(app);
}
