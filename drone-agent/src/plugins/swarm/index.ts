import type {
  DronePlugin,
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
} from 'drone-core';
import { PRECEDENCE_COORDINATOR, PRECEDENCE_SWARM } from 'drone-core';

const DEFAULT_BEACON_HOST = 'localhost';
const DEFAULT_BEACON_PORT = 3457;

/**
 * Configuration for the swarm plugin.
 */
export interface SwarmConfig {
  beaconHost?: string;
  beaconPort?: number;
  sessionId?: string;
}

/**
 * The swarm plugin connects to a drone-beacon and provides
 * personas and skills from the beacon's aggregated store.
 */
export function createSwarmPlugin(config: SwarmConfig): DronePlugin {
  const beaconHost = config.beaconHost ?? DEFAULT_BEACON_HOST;
  const beaconPort = config.beaconPort ?? DEFAULT_BEACON_PORT;
  const baseUrl = `http://${beaconHost}:${beaconPort}`;
  const sessionId = config.sessionId ?? `agent-${Date.now()}`;

  return {
    metadata: {
      id: 'swarm',
      name: 'Swarm',
      version: '0.1.0',
      description:
        'Connects to a drone-beacon for swarm-wide personas and skills.',
      defaultEnabled: false,
      dependencies: [
        { id: 'persona' },
        { id: 'skills', optional: true },
      ],
    },
    register: async (registration) => {
      registration.logger.info(
        `Connecting to beacon at ${baseUrl} (session: ${sessionId})`
      );

      // Register the agent session with the beacon
      try {
        await fetch(`${baseUrl}/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, personaId: null }),
        });
        registration.logger.info('Registered with beacon');
      } catch (err) {
        registration.logger.error(
          `Failed to register with beacon: ${err}. Swarm features will be disabled.`
        );
        return;
      }

      // Keep track of loaded data
      let beaconPersonas = new Map<string, DronePersonaDefinition>();
      let coordinatorPersonas = new Map<string, DronePersonaDefinition>();
      let beaconSkills = new Map<string, DroneSkillDefinition>();
      let coordinatorSkills = new Map<string, DroneSkillDefinition>();

      // Helper to load all data from beacon
      const reloadFromBeacon = async () => {
        try {
          // Fetch personas
          const personasResp = await fetch(`${baseUrl}/personas`);
          if (!personasResp.ok) {
            throw new Error(`Failed to fetch personas: ${personasResp.status}`);
          }
          const personasData = await personasResp.json() as DronePersonaDefinition[];
          beaconPersonas = new Map();
          coordinatorPersonas = new Map();

          for (const p of personasData) {
            if ((p as any).scope === 'coordinator') {
              coordinatorPersonas.set(p.id, p);
            } else {
              beaconPersonas.set(p.id, p);
            }
          }

          // Fetch skills
          const skillsResp = await fetch(`${baseUrl}/skills`);
          if (!skillsResp.ok) {
            throw new Error(`Failed to fetch skills: ${skillsResp.status}`);
          }
          const skillsData = await skillsResp.json() as DroneSkillDefinition[];
          beaconSkills = new Map();
          coordinatorSkills = new Map();

          for (const s of skillsData) {
            if ((s as any).scope === 'coordinator') {
              coordinatorSkills.set(s.id, s);
            } else {
              beaconSkills.set(s.id, s);
            }
          }

          registration.logger.info(
            `Loaded ${beaconPersonas.size} beacon + ${coordinatorPersonas.size} coordinator personas`
          );
          registration.logger.info(
            `Loaded ${beaconSkills.size} beacon + ${coordinatorSkills.size} coordinator skills`
          );
        } catch (err) {
          registration.logger.error(`Failed to reload from beacon: ${err}`);
        }
      };

      // ── Beacon-level persona provider ─────────────────────────────────
      const beaconPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-beacon',
        precedence: PRECEDENCE_SWARM,
        getPersonas: () => Array.from(beaconPersonas.values()),
        getPersona: (id: string) => beaconPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      // ── Coordinator-level persona provider ─────────────────────────────
      const coordinatorPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getPersonas: () => Array.from(coordinatorPersonas.values()),
        getPersona: (id: string) => coordinatorPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      // ── Beacon-level skill provider ────────────────────────────────────
      const beaconSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-beacon',
        precedence: PRECEDENCE_SWARM,
        getSkills: () => Array.from(beaconSkills.values()),
        getSkill: (id: string) => beaconSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      // ── Coordinator-level skill provider ───────────────────────────────
      const coordinatorSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getSkills: () => Array.from(coordinatorSkills.values()),
        getSkill: (id: string) => coordinatorSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      // Register with persona broker
      const personaCap = registration.request<DronePersonaCapability>('persona');
      if (personaCap) {
        personaCap.registerProvider(beaconPersonaProvider);
        personaCap.registerProvider(coordinatorPersonaProvider);
      } else {
        registration.logger.warn(
          'persona broker not available; swarm personas will not be loaded'
        );
      }

      // Register with skills broker
      const skillsCap = registration.request<DroneSkillsCapability>('skills');
      if (skillsCap) {
        skillsCap.registerProvider(beaconSkillProvider);
        skillsCap.registerProvider(coordinatorSkillProvider);
      } else {
        registration.logger.warn(
          'skills broker not available; swarm skills will not be loaded'
        );
      }

      // Initial load
      registration.hooks.onPluginsLoaded(async () => {
        await reloadFromBeacon();
      });

      // Heartbeat to keep session alive
      const heartbeat = async () => {
        try {
          await fetch(`${baseUrl}/agents/${sessionId}/heartbeat`, {
            method: 'POST',
          });
        } catch {
          // Silently ignore heartbeat failures
        }
      };

      // Heartbeat every 30 seconds
      const heartbeatInterval = setInterval(heartbeat, 30000);

      // Cleanup on shutdown
      registration.hooks.onShutdown(async () => {
        clearInterval(heartbeatInterval);
        try {
          await fetch(`${baseUrl}/agents/${sessionId}`, {
            method: 'DELETE',
          });
        } catch {
          // Silently ignore cleanup failures
        }
      });
    },
  };
}

// Default instance for easy configuration
export const swarmPlugin = createSwarmPlugin({});