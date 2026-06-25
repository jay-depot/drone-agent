import { logger } from './logger.js';
import type { Persona, Skill, CoordinatorConfig } from './types.js';

export interface CoordinatorClient {
  registerBeacon(config: CoordinatorConfig): Promise<void>;
  heartbeat(): Promise<void>;
  fetchPersonas(): Promise<Persona[]>;
  fetchSkills(): Promise<Skill[]>;

  // Session management
  registerSession(agentId: string, personaId: string | null): Promise<void>;
  endSession(agentId: string, connectedAt: number): Promise<void>;

  // Knowledge sync (push)
  pushPersona(persona: Persona): Promise<void>;
  pushSkill(skill: Skill): Promise<void>;
  deletePersona(id: string): Promise<void>;
  deleteSkill(id: string): Promise<void>;
}

export interface SessionInfo {
  id: string;
  agentId: string;
  personaId: string | null;
}

export function createCoordinatorClient(
  config: CoordinatorConfig
): CoordinatorClient {
  const baseUrl = `http://${config.host}:${config.port}`;

  return {
    async registerBeacon(cfg: CoordinatorConfig): Promise<void> {
      logger.info(`Registering beacon with coordinator at ${baseUrl}`);
      const res = await fetch(`${baseUrl}/beacons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cfg.beaconId,
          name: cfg.beaconName,
          host: cfg.host,
          port: cfg.port,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to register beacon: ${res.status}`);
      }
      logger.info('Beacon registered with coordinator');
    },

    async heartbeat(): Promise<void> {
      const res = await fetch(
        `${baseUrl}/beacons/${config.beaconId}/heartbeat`,
        {
          method: 'POST',
        }
      );
      if (!res.ok) {
        logger.warn(`Heartbeat failed: ${res.status}`);
      }
    },

    async fetchPersonas(): Promise<Persona[]> {
      const res = await fetch(`${baseUrl}/personas`);
      if (!res.ok) {
        throw new Error(`Failed to fetch personas: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const personas = data as Persona[];
      // Mark them as coordinator scope
      return personas.map(p => ({ ...p, scope: 'coordinator' as const }));
    },

    async fetchSkills(): Promise<Skill[]> {
      const res = await fetch(`${baseUrl}/skills`);
      if (!res.ok) {
        throw new Error(`Failed to fetch skills: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const skills = data as Skill[];
      // Mark them as coordinator scope
      return skills.map(s => ({ ...s, scope: 'coordinator' as const }));
    },

    // Session management
    async registerSession(
      agentId: string,
      personaId: string | null
    ): Promise<void> {
      try {
        const res = await fetch(
          `${baseUrl}/beacons/${config.beaconId}/sessions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `session-${agentId}-${Date.now()}`,
              agentId,
              personaId: personaId ?? undefined,
            }),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to register session: ${res.status}`);
        } else {
          logger.info(`Registered session for agent ${agentId}`);
        }
      } catch (err) {
        logger.warn(`Failed to register session: ${err}`);
      }
    },

    async endSession(agentId: string, connectedAt: number): Promise<void> {
      try {
        const disconnectedAt = Date.now();
        const durationMs = disconnectedAt - connectedAt;
        const res = await fetch(
          `${baseUrl}/beacons/${config.beaconId}/sessions/${agentId}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              disconnectedAt,
              durationMs,
            }),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to end session: ${res.status}`);
        } else {
          logger.info(
            `Ended session for agent ${agentId}, duration: ${durationMs}ms`
          );
        }
      } catch (err) {
        logger.warn(`Failed to end session: ${err}`);
      }
    },

    // Knowledge push
    async pushPersona(persona: Persona): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}/personas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(persona),
        });
        if (!res.ok) {
          logger.warn(`Failed to push persona: ${res.status}`);
        } else {
          logger.info(`Pushed persona ${persona.id} to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push persona: ${err}`);
      }
    },

    async pushSkill(skill: Skill): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(skill),
        });
        if (!res.ok) {
          logger.warn(`Failed to push skill: ${res.status}`);
        } else {
          logger.info(`Pushed skill ${skill.id} to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push skill: ${err}`);
      }
    },

    async deletePersona(id: string): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}/personas/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to delete persona: ${res.status}`);
        } else {
          logger.info(`Deleted persona ${id} from coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to delete persona: ${err}`);
      }
    },

    async deleteSkill(id: string): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}/skills/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to delete skill: ${res.status}`);
        } else {
          logger.info(`Deleted skill ${id} from coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to delete skill: ${err}`);
      }
    },
  };
}
