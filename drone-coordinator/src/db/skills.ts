import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Skill, CreateSkillRequest } from '../types.js';
import { getRow, listRows, deleteRow } from 'drone-swarm-common';

export function createSkill(req: CreateSkillRequest): Skill {
  const now = Date.now();
  const skill: Skill = {
    id: req.id,
    name: req.name,
    description: req.description,
    trigger: req.trigger,
    body: req.body,
    scope: 'coordinator',
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO skills (id, name, description, trigger, body, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @trigger, @body, @scope, @createdAt, @updatedAt)
  `);

  stmt.run(skill);
  logger.info(`Created skill: ${skill.id}`);
  return skill;
}

export function getSkill(id: string): Skill | undefined {
  return getRow<Skill>(getDatabase, 'skills', id);
}

export function listSkills(): Skill[] {
  return listRows<Skill>(getDatabase, 'skills', { orderBy: 'name' });
}

export function updateSkill(
  id: string,
  req: Partial<CreateSkillRequest>
): Skill | undefined {
  const existing = getSkill(id);
  if (!existing) return undefined;

  const updated: Skill = {
    ...existing,
    ...req,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE skills 
    SET name = @name, description = @description, trigger = @trigger, body = @body, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run(updated);
  logger.info(`Updated skill: ${id}`);
  return updated;
}

export function deleteSkill(id: string): boolean {
  const result = deleteRow(getDatabase, 'skills', id);
  logger.info(`Deleted skill: ${id}`);
  return result;
}
