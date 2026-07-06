import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Persona, CreatePersonaRequest } from '../types.js';
import { getRow, listRows, deleteRow } from 'drone-swarm-common';

export function createPersona(req: CreatePersonaRequest): Persona {
  const now = Date.now();
  const persona: Persona = {
    id: req.id,
    name: req.name,
    description: req.description,
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

  const updated: Persona = {
    ...existing,
    ...req,
    id: existing.id,
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
