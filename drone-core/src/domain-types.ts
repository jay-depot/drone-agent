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
  /**
   * Storage primary key. Global skills key on their bare public id;
   * persona-owned skills key on `<personaId>/<skillId>`.
   */
  key: string;
  /** Public skill id. Flat: it may repeat across different owners. */
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope: 'local' | 'coordinator';
  /** Owning persona id, or `null` for a global skill. */
  personaId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Request to create a new Persona. */
export type CreatePersonaRequest = {
  id: string;
  name?: string;
  description?: string;
  systemPrompt: string;
  scope?: 'local' | 'coordinator';
};

/** Request to create a new Skill. */
export type CreateSkillRequest = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  /** Owning persona id. Omit or `null` for a global skill. */
  personaId?: string | null;
};
