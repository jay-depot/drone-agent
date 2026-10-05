import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Persona, CreatePersonaRequest } from '../types.js';
import {
  getRow,
  listRows,
  deleteRow,
  derivePersonaMetadata,
} from 'drone-swarm-common';
import { deleteSkillsByPersona } from './skills.js';

export function createPersona(req: CreatePersonaRequest): Persona {
  const now = Date.now();
  const { name, description } = derivePersonaMetadata(req.systemPrompt, req.id);
  const persona: Persona = {
    id: req.id,
    name,
    description,
    systemPrompt: req.systemPrompt,
    scope: 'coordinator',
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO personas (id, name, description, systemPrompt, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @systemPrompt, @scope, @createdAt, @updatedAt)
  `);

  stmt.run(persona);
  logger.info(`Created persona: ${persona.id}`);
  return persona;
}

export function getPersona(id: string): Persona | undefined {
  return getRow<Persona>(getDatabase, 'personas', id);
}

export function listPersonas(): Persona[] {
  return listRows<Persona>(getDatabase, 'personas', { orderBy: 'name' });
}

export function updatePersona(
  id: string,
  req: Partial<CreatePersonaRequest>
): Persona | undefined {
  const existing = getPersona(id);
  if (!existing) return undefined;

  const systemPrompt = req.systemPrompt ?? existing.systemPrompt;
  const { name, description } = derivePersonaMetadata(systemPrompt, id);
  const updated: Persona = {
    ...existing,
    ...req,
    id: existing.id,
    name,
    description,
    systemPrompt,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE personas 
    SET name = @name, description = @description, systemPrompt = @systemPrompt, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run(updated);
  logger.info(`Updated persona: ${id}`);
  return updated;
}

export function deletePersona(id: string): boolean {
  const result = deleteRow(getDatabase, 'personas', id);
  logger.info(`Deleted persona: ${id}`);
  return result;
}

/**
 * Delete a persona and cascade-delete the skills it owns, atomically.
 * Returns true when the persona row was removed.
 */
export function deletePersonaWithSkills(id: string): boolean {
  const database = getDatabase();
  const run = database.transaction(() => {
    deleteSkillsByPersona(id);
    const stmt = database.prepare('DELETE FROM personas WHERE id = ?');
    const result = stmt.run(id) as { changes?: number } | undefined;
    return (result?.changes ?? 0) > 0;
  });
  const deleted = run();
  if (deleted) logger.info(`Deleted persona (with owned skills): ${id}`);
  return deleted;
}

/**
 * Re-derive `name` and `description` for every persona row from its stored
 * `systemPrompt`. Idempotent: only rows whose derived values differ are
 * written, and `updatedAt` is left untouched.
 */
export function backfillPersonaMetadata(): number {
  const database = getDatabase();
  const rows = listPersonas();
  const stmt = database.prepare(
    'UPDATE personas SET name = @name, description = @description WHERE id = @id'
  );
  let repaired = 0;
  for (const p of rows) {
    const { name, description } = derivePersonaMetadata(p.systemPrompt, p.id);
    if (p.name === name && p.description === description) continue;
    stmt.run({ id: p.id, name, description });
    repaired += 1;
  }
  return repaired;
}
