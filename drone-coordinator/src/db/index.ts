export { initDatabase, getDatabase, closeDatabase } from './init.js';
export type { ToolDefinition } from './init.js';
export {
  upsertToolDefinition,
  getToolDefinitions,
  getDefaultHiddenTools,
  seedBuiltinToolDefinitions,
} from './init.js';
export {
  createPersona,
  getPersona,
  listPersonas,
  updatePersona,
  deletePersona,
} from './personas.js';
export {
  createSkill,
  getSkill,
  listSkills,
  updateSkill,
  deleteSkill,
} from './skills.js';
export {
  registerBeacon,
  getBeacon,
  listBeacons,
  heartbeatBeacon,
  deleteBeacon,
} from './beacons.js';
export {
  registerBeaconTrust,
  getBeaconTrust,
  listBeaconTrust,
  approveBeacon,
  rejectBeacon,
  deleteBeaconTrust,
} from './beacon-trust.js';
export {
  createBeaconSession,
  getBeaconSession,
  listBeaconSessions,
  endBeaconSession,
  deleteBeaconSession,
} from './beacon-sessions.js';
export {
  createKnowledge,
  getKnowledge,
  listKnowledge,
  updateKnowledge,
  deleteKnowledge,
  searchKnowledge,
  upsertKnowledge,
} from './knowledge.js';
export {
  createSwarmSession,
  getSwarmSession,
  countSwarmSessions,
  listSwarmSessions,
  updateSwarmSessionStatus,
  transitionSessionStatus,
  getStaleSessions,
  createSwarmEvent,
  getSwarmEvents,
  getLatestSwarmEvents,
  searchSwarmEvents,
} from './swarm-sessions.js';
export type { SwarmSession, SwarmEvent } from './swarm-sessions.js';
export {
  registerAgentLocation,
  getAgentLocation,
  updateAgentLocationHeartbeat,
  unregisterAgentLocation,
  listAgentLocationsByBeacon,
  listAllAgentLocations,
} from './agent-locations.js';
export type { AgentLocation } from './agent-locations.js';
export {
  createInsight,
  getInsight,
  listInsights,
  deleteInsight,
} from './insights.js';
export type { InsightRow } from './insights.js';
export {
  createPrinciple,
  getPrinciple,
  listPrinciples,
  deletePrinciple,
} from './principles.js';
export type { PrincipleRow } from './principles.js';
export { getWebToken, generateWebToken, initWebToken } from './web-token.js';
