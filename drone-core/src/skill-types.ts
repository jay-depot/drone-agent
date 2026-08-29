// ── Skill definition types ─────────────────────────────────────────

export type DroneSkillDefinition = {
  id: string;
  name: string;
  description: string;
  recall: string[];
  modelInvocation: boolean;
  /**
   * Author-facing remark (credit/license note). Shown on user-facing
   * listings only; never sent to the LLM. Local-scope only: not
   * propagated by swarm sync.
   */
  remark?: string;
  body: string;
  source: 'user' | 'project' | 'beacon' | 'coordinator';
  /** Precedence assigned by the provider. Lower number = higher priority. */
  precedence?: number;
  /**
   * If this skill is owned by a persona, the persona's id.
   * Set by the persona provider plugin when loading persona-owned skills.
   */
  personaId?: string;
};

/**
 * Callback invoked after a skill is recalled. Receives the skill id and
 * the current body text. Returns a modified body (or the original).
 */
export type DroneRecallEnhancer = (id: string, body: string) => Promise<string>;
