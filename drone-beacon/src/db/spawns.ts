import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { SpawnRecord, SpawnConfig } from '../types.js';
import { getRow, deleteRow } from 'drone-swarm-common';

interface SpawnRow {
  id: string;
  agent_id: string | null;
  persona_id: string | null;
  task: string | null;
  config_json: string | null;
  status: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  terminated_at: number | null;
  exit_code: number | null;
}

function rowToSpawnRecord(row: SpawnRow): SpawnRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    personaId: row.persona_id,
    task: row.task,
    configJson: row.config_json,
    status: row.status as SpawnRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    terminatedAt: row.terminated_at ?? null,
    exitCode: row.exit_code ?? null,
  };
}

export function createSpawn(
  spawnId: string,
  personaId: string | null,
  task: string | null,
  config: SpawnConfig | null
): SpawnRecord {
  const now = Date.now();
  const spawn: SpawnRecord = {
    id: spawnId,
    agentId: null,
    personaId,
    task,
    configJson: config ? JSON.stringify(config) : null,
    status: 'spawning',
    error: null,
    createdAt: now,
    startedAt: null,
    terminatedAt: null,
    exitCode: null,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO spawns (id, agent_id, persona_id, task, config_json, status, error, created_at, started_at, terminated_at, exit_code)
    VALUES (@id, @agentId, @personaId, @task, @configJson, @status, @error, @createdAt, @startedAt, @terminatedAt, @exitCode)
  `);

  stmt.run({
    id: spawn.id,
    agentId: spawn.agentId,
    personaId: spawn.personaId,
    task: spawn.task,
    configJson: spawn.configJson,
    status: spawn.status,
    error: spawn.error,
    createdAt: spawn.createdAt,
    startedAt: spawn.startedAt,
    terminatedAt: spawn.terminatedAt,
    exitCode: spawn.exitCode,
  });

  logger.info(`Created spawn: ${spawn.id}`);
  return spawn;
}

export function getSpawn(id: string): SpawnRecord | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM spawns WHERE id = ?');
  const row = stmt.get(id) as SpawnRow | undefined;
  if (!row) return undefined;
  return rowToSpawnRecord(row);
}

export function listSpawns(status?: string): SpawnRecord[] {
  let sql = 'SELECT * FROM spawns';
  const params: string[] = [];

  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';

  const stmt = getDatabase().prepare(sql);
  const rows = (
    params.length > 0 ? stmt.all(...params) : stmt.all()
  ) as SpawnRow[];
  return rows.map(rowToSpawnRecord);
}

export function updateSpawnStatus(
  id: string,
  status: SpawnRecord['status'],
  agentId?: string | null,
  error?: string,
  exitCode?: number
): SpawnRecord | undefined {
  const existing = getSpawn(id);
  if (!existing) return undefined;

  const now = Date.now();
  const updates: string[] = ['status = ?'];
  const params: (string | number | null)[] = [status];

  if (agentId !== undefined) {
    updates.push('agent_id = ?');
    params.push(agentId);
  }

  if (status === 'running' && !existing.startedAt) {
    updates.push('started_at = ?');
    params.push(now);
  }

  if (error !== undefined) {
    updates.push('error = ?');
    params.push(error);
  }

  if (exitCode !== undefined) {
    updates.push('exit_code = ?');
    params.push(exitCode);
  }

  if (status === 'terminated') {
    updates.push('terminated_at = ?');
    params.push(now);
  }

  params.push(id);

  const stmt = getDatabase().prepare(
    `UPDATE spawns SET ${updates.join(', ')} WHERE id = ?`
  );
  stmt.run(...params);

  logger.info(`Updated spawn ${id}: status=${status}`);
  return getSpawn(id);
}

export function deleteSpawn(id: string): boolean {
  const result = deleteRow(getDatabase, 'spawns', id);
  logger.info(`Deleted spawn: ${id}`);
  return result;
}

export function getSpawnByAgentId(agentId: string): SpawnRecord | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM spawns WHERE agent_id = ?');
  const row = stmt.get(agentId) as SpawnRow | undefined;
  if (!row) return undefined;
  return rowToSpawnRecord(row);
}
