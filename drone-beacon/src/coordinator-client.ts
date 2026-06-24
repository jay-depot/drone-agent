import { logger } from "./logger.js";
import type { Persona, Skill, CoordinatorConfig } from "./types.js";

export interface CoordinatorClient {
  registerBeacon(config: CoordinatorConfig): Promise<void>;
  heartbeat(): Promise<void>;
  fetchPersonas(): Promise<Persona[]>;
  fetchSkills(): Promise<Skill[]>;
}

export function createCoordinatorClient(config: CoordinatorConfig): CoordinatorClient {
  const baseUrl = `http://${config.host}:${config.port}`;

  return {
    async registerBeacon(cfg: CoordinatorConfig): Promise<void> {
      logger.info(`Registering beacon with coordinator at ${baseUrl}`);
      const res = await fetch(`${baseUrl}/beacons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      logger.info("Beacon registered with coordinator");
    },

    async heartbeat(): Promise<void> {
      const res = await fetch(`${baseUrl}/beacons/${config.beaconId}/heartbeat`, {
        method: "POST",
      });
      if (!res.ok) {
        logger.warn(`Heartbeat failed: ${res.status}`);
      }
    },

    async fetchPersonas(): Promise<Persona[]> {
      const res = await fetch(`${baseUrl}/personas`);
      if (!res.ok) {
        throw new Error(`Failed to fetch personas: ${res.status}`);
      }
      const data = await res.json() as unknown;
      const personas = data as Persona[];
      // Mark them as coordinator scope
      return personas.map(p => ({ ...p, scope: "coordinator" as const }));
    },

    async fetchSkills(): Promise<Skill[]> {
      const res = await fetch(`${baseUrl}/skills`);
      if (!res.ok) {
        throw new Error(`Failed to fetch skills: ${res.status}`);
      }
      const data = await res.json() as unknown;
      const skills = data as Skill[];
      // Mark them as coordinator scope
      return skills.map(s => ({ ...s, scope: "coordinator" as const }));
    },
  };
}