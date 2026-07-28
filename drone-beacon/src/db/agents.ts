import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { AgentSession, RegisterAgentRequest } from '../types.js';
import { getRow } from 'drone-swarm-common';

export function registerAgent(req: RegisterAgentRequest): AgentSession {
  const now = Date.now();
  const session: AgentSession = {
    id: req.id,
    personaId: req.personaId,
    connectedAt: now,
    lastActivity: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO agent_sessions (id, personaId, connectedAt, lastActivity)
    VALUES (@id, @personaId, @connectedAt, @lastActivity)
  `);

  stmt.run(session);
  logger.info(`Registered agent: ${session.id}`);
  return session;
}

export function getAgent(id: string): AgentSession | undefined {
  return getRow<AgentSession>(getDatabase, 'agent_sessions', id);
}

export function listAgents(): AgentSession[] {
  const stmt = getDatabase().prepare('SELECT * FROM agent_sessions');
  return stmt.all() as AgentSession[];
}

export function updateAgentActivity(id: string): AgentSession | undefined {
  const session = getAgent(id);
  if (!session) return undefined;

  session.lastActivity = Date.now();

  const stmt = getDatabase().prepare(`
    UPDATE agent_sessions SET lastActivity = @lastActivity WHERE id = @id
  `);

  stmt.run(session);
  return session;
}

export function unregisterAgent(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM agent_sessions WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Unregistered agent: ${id}`);
  return result.changes > 0;
}

export function updateAgentPersona(
  id: string,
  personaId: string | null
): AgentSession | undefined {
  const session = getAgent(id);
  if (!session) return undefined;

  session.personaId = personaId;

  const stmt = getDatabase().prepare(`
    UPDATE agent_sessions SET personaId = @personaId WHERE id = @id
  `);

  stmt.run({ id, personaId });
  logger.info(`Updated agent ${id} persona to: ${personaId ?? 'none'}`);
  return session;
}
