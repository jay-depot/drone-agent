// ── Domain types (shared between beacon/coordinator) ────────────────

/**
 * Canonical Persona type for persistence (used by beacon/coordinator).
 * For runtime config, see DronePersonaDefinition.
 */
export type Persona = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope: 'local' | 'coordinator';
  createdAt: number;
  updatedAt: number;
};

/**
 * Canonical Skill type for persistence (used by beacon/coordinator).
 * For runtime config, see DroneSkillDefinition.
 */
export type Skill = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope: 'local' | 'coordinator';
  createdAt: number;
  updatedAt: number;
};

/** Request to create a new Persona. */
export type CreatePersonaRequest = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
};

/** Request to create a new Skill. */
export type CreateSkillRequest = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
};
