/**
 * Persona and skill providers and writers for the swarm plugin.
 *
 * These register with the persona and skills broker plugins to make
 * beacon/coordinator-scoped personas and skills available to the agent.
 */

import type {
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePersonaWriter,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
  DroneSkillWriter,
} from 'drone-core';
import { PRECEDENCE_COORDINATOR, PRECEDENCE_SWARM } from 'drone-core';
import { parsePersonaMd } from '../persona/loader.js';
import type { SwarmContext } from './context.js';

/**
 * Reload personas and skills from the beacon, splitting by scope.
 */
export async function reloadFromBeacon(ctx: SwarmContext): Promise<void> {
  const { baseUrl, registration } = ctx;
  try {
    const personasResp = await fetch(`${baseUrl}/personas`);
    if (!personasResp.ok) {
      throw new Error(`Failed to fetch personas: ${personasResp.status}`);
    }
    const rawPersonas = (await personasResp.json()) as Array<{
      id: string;
      name: string;
      description: string;
      systemPrompt: string;
      scope: string;
    }>;
    ctx.beaconPersonas = new Map();
    ctx.coordinatorPersonas = new Map();

    for (const p of rawPersonas) {
      // Parse the .md content to extract all rich fields
      const definition = parsePersonaMd(p.id, p.systemPrompt);
      // Preserve the scope from the DB, not from the .md frontmatter
      definition.scope = p.scope === 'coordinator' ? 'coordinator' : 'beacon';

      if (p.scope === 'coordinator') {
        ctx.coordinatorPersonas.set(p.id, definition);
      } else {
        ctx.beaconPersonas.set(p.id, definition);
      }
    }

    const skillsResp = await fetch(`${baseUrl}/skills`);
    if (!skillsResp.ok) {
      throw new Error(`Failed to fetch skills: ${skillsResp.status}`);
    }
    const skillsData = (await skillsResp.json()) as DroneSkillDefinition[];
    ctx.beaconSkills = new Map();
    ctx.coordinatorSkills = new Map();

    for (const s of skillsData) {
      if ((s as any).scope === 'coordinator') {
        ctx.coordinatorSkills.set(s.id, s);
      } else {
        ctx.beaconSkills.set(s.id, s);
      }
    }

    registration.logger.info(
      `Loaded ${ctx.beaconPersonas.size} beacon + ${ctx.coordinatorPersonas.size} coordinator personas`
    );
    registration.logger.info(
      `Loaded ${ctx.beaconSkills.size} beacon + ${ctx.coordinatorSkills.size} coordinator skills`
    );
  } catch (err) {
    registration.logger.error(`Failed to reload from beacon: ${err}`);
  }
}

/**
 * Create and register persona providers and writers with the persona broker.
 */
export function registerPersonaProviders(
  ctx: SwarmContext,
  personaCap: DronePersonaCapability
): void {
  const { registration } = ctx;

  const beaconPersonaProvider: DronePersonaProvider = {
    id: 'swarm-persona-beacon',
    precedence: PRECEDENCE_SWARM,
    getPersonas: () => Array.from(ctx.beaconPersonas.values()),
    getPersona: (id: string) => ctx.beaconPersonas.get(id),
    reloadPersonas: () => reloadFromBeacon(ctx),
  };

  const coordinatorPersonaProvider: DronePersonaProvider = {
    id: 'swarm-persona-coordinator',
    precedence: PRECEDENCE_COORDINATOR,
    getPersonas: () => Array.from(ctx.coordinatorPersonas.values()),
    getPersona: (id: string) => ctx.coordinatorPersonas.get(id),
    reloadPersonas: () => reloadFromBeacon(ctx),
  };

  personaCap.registerProvider(beaconPersonaProvider);
  personaCap.registerProvider(coordinatorPersonaProvider);

  // ── Persona writers ────────────────────────────────────────────
  const beaconPersonaWriter: DronePersonaWriter = {
    id: 'swarm-persona-beacon',
    scope: 'beacon',
    label: 'Beacon (swarm-wide, local hub)',
    exists: async (id: string) => {
      try {
        const res = await fetch(`${ctx.baseUrl}/personas/${id}`);
        return res.ok;
      } catch {
        return false;
      }
    },
    writePersona: async (id: string, content: string) => {
      const res = await fetch(`${ctx.baseUrl}/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          systemPrompt: content,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to write persona to beacon: ${res.status}`);
      }
      return { filePath: `${ctx.baseUrl}/personas/${id}` };
    },
  };
  personaCap.registerWriter(beaconPersonaWriter);

  const coordinatorPersonaWriter: DronePersonaWriter = {
    id: 'swarm-persona-coordinator',
    scope: 'coordinator',
    label: 'Coordinator (global swarm hub)',
    exists: async (id: string) => {
      try {
        const res = await fetch(`${ctx.baseUrl}/personas/${id}`);
        return res.ok;
      } catch {
        return false;
      }
    },
    writePersona: async (id: string, content: string) => {
      const res = await fetch(`${ctx.baseUrl}/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          systemPrompt: content,
          scope: 'coordinator',
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to write persona to coordinator: ${res.status}`
        );
      }
      return { filePath: `${ctx.baseUrl}/personas/${id}` };
    },
  };
  personaCap.registerWriter(coordinatorPersonaWriter);
}

/**
 * Create and register skill providers and writers with the skills broker.
 */
export function registerSkillProviders(
  ctx: SwarmContext,
  skillsCap: DroneSkillsCapability
): void {
  const { registration } = ctx;

  const beaconSkillProvider: DroneSkillProvider = {
    id: 'swarm-skill-beacon',
    precedence: PRECEDENCE_SWARM,
    getSkills: () => Array.from(ctx.beaconSkills.values()),
    getSkill: (id: string) => ctx.beaconSkills.get(id),
    reloadSkills: () => reloadFromBeacon(ctx),
  };

  const coordinatorSkillProvider: DroneSkillProvider = {
    id: 'swarm-skill-coordinator',
    precedence: PRECEDENCE_COORDINATOR,
    getSkills: () => Array.from(ctx.coordinatorSkills.values()),
    getSkill: (id: string) => ctx.coordinatorSkills.get(id),
    reloadSkills: () => reloadFromBeacon(ctx),
  };

  skillsCap.registerProvider(beaconSkillProvider);
  skillsCap.registerProvider(coordinatorSkillProvider);

  // ── Skill writers ─────────────────────────────────────────────
  const beaconSkillWriter: DroneSkillWriter = {
    id: 'swarm-skill-beacon',
    scope: 'beacon',
    label: 'Beacon (swarm-wide, local hub)',
    exists: async (id: string) => {
      try {
        const res = await fetch(`${ctx.baseUrl}/skills/${id}`);
        return res.ok;
      } catch {
        return false;
      }
    },
    writeSkill: async (id: string, content: string) => {
      const res = await fetch(`${ctx.baseUrl}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          trigger: '',
          body: content,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to write skill to beacon: ${res.status}`);
      }
      return { filePath: `${ctx.baseUrl}/skills/${id}` };
    },
  };
  skillsCap.registerWriter(beaconSkillWriter);

  const coordinatorSkillWriter: DroneSkillWriter = {
    id: 'swarm-skill-coordinator',
    scope: 'coordinator',
    label: 'Coordinator (global swarm hub)',
    exists: async (id: string) => {
      try {
        const res = await fetch(`${ctx.baseUrl}/skills/${id}`);
        return res.ok;
      } catch {
        return false;
      }
    },
    writeSkill: async (id: string, content: string) => {
      const res = await fetch(`${ctx.baseUrl}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          trigger: '',
          body: content,
          scope: 'coordinator',
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to write skill to coordinator: ${res.status}`);
      }
      return { filePath: `${ctx.baseUrl}/skills/${id}` };
    },
  };
  skillsCap.registerWriter(coordinatorSkillWriter);
}
