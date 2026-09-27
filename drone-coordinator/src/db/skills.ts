import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Skill, CreateSkillRequest } from '../types.js';
import { listRows } from 'drone-swarm-common';
import { skillStorageKey } from 'drone-core';

/**
 * Options for {@link createSkill}. A skill's owner (`personaId`) is
 * server-derived, so it is passed here rather than trusted from the request
 * body. Coordinator skills are always coordinator-scoped.
 */
export type CreateSkillOptions = {
  personaId?: string | null;
};

export function createSkill(
  req: CreateSkillRequest,
  opts: CreateSkillOptions = {}
): Skill {
  const now = Date.now();
  const personaId = opts.personaId ?? req.personaId ?? null;
  const skill: Skill = {
    key: skillStorageKey(personaId, req.id),
    id: req.id,
    name: req.name,
    description: req.description,
    trigger: req.trigger,
    body: req.body,
    scope: 'coordinator',
    personaId,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO skills (key, id, name, description, trigger, body, scope, personaId, createdAt, updatedAt)
    VALUES (@key, @id, @name, @description, @trigger, @body, @scope, @personaId, @createdAt, @updatedAt)
  `);

  stmt.run(skill);
  logger.info(
    `Created skill: ${skill.id}${personaId ? ` (owned by ${personaId})` : ''}`
  );
  return skill;
}

export function getSkillByKey(key: string): Skill | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM skills WHERE key = ?');
  return stmt.get(key) as Skill | undefined;
}

/** Look up a global skill by its public id (global rows keep `key === id`). */
export function getGlobalSkill(id: string): Skill | undefined {
  return getSkillByKey(id);
}

/**
 * Backward-compatible plain-id lookup. Prefers the global skill, then falls
 * back to any owner. New code should use {@link getSkillByKey}.
 */
export function getSkill(id: string): Skill | undefined {
  const global = getSkillByKey(id);
  if (global) return global;
  const stmt = getDatabase().prepare(
    'SELECT * FROM skills WHERE id = ? LIMIT 1'
  );
  return stmt.get(id) as Skill | undefined;
}

export function listSkills(): Skill[] {
  return listRows<Skill>(getDatabase, 'skills', { orderBy: 'name' });
}

export function listSkillsByPersona(personaId: string): Skill[] {
  return listRows<Skill>(getDatabase, 'skills', {
    filter: 'WHERE personaId = ?',
    params: [personaId],
    orderBy: 'name',
  });
}

/**
 * Update the mutable fields of a skill addressed by storage key. The
 * `key`/`id`/`scope`/`personaId` identity fields are immutable.
 */
export function updateSkillByKey(
  key: string,
  req: Partial<CreateSkillRequest>
): Skill | undefined {
  const existing = getSkillByKey(key);
  if (!existing) return undefined;

  const updated: Skill = {
    ...existing,
    name: req.name ?? existing.name,
    description: req.description ?? existing.description,
    trigger: req.trigger ?? existing.trigger,
    body: req.body ?? existing.body,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE skills
    SET name = @name, description = @description, trigger = @trigger, body = @body, updatedAt = @updatedAt
    WHERE key = @key
  `);

  stmt.run(updated);
  logger.info(`Updated skill: ${updated.id}`);
  return updated;
}

export function updateSkill(
  id: string,
  req: Partial<CreateSkillRequest>
): Skill | undefined {
  return updateSkillByKey(id, req);
}

export function deleteSkillByKey(key: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM skills WHERE key = ?');
  const result = stmt.run(key) as { changes?: number } | undefined;
  const deleted = (result?.changes ?? 0) > 0;
  if (deleted) logger.info(`Deleted skill: ${key}`);
  return deleted;
}

export function deleteSkill(id: string): boolean {
  return deleteSkillByKey(id);
}

/** Delete every skill owned by a persona. Returns the number of rows removed. */
export function deleteSkillsByPersona(personaId: string): number {
  const stmt = getDatabase().prepare('DELETE FROM skills WHERE personaId = ?');
  const result = stmt.run(personaId) as { changes?: number } | undefined;
  const removed = result?.changes ?? 0;
  if (removed > 0) {
    logger.info(`Deleted ${removed} skill(s) owned by persona ${personaId}`);
  }
  return removed;
}
