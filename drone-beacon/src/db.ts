import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  Persona,
  Skill,
  AgentSession,
  CreatePersonaRequest,
  CreateSkillRequest,
  RegisterAgentRequest,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  Memory,
  SpawnRecord,
  SpawnConfig,
  AgentMessage,
  EventLog,
  CreateEventLogRequest,
  EventType,
  Knowledge,
} from './types.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';

let db: Database.Database | null = null;

export function initDatabase(dataPath: string): Database.Database {
  logger.info(`Initializing database at: ${dataPath}`);
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  db = new Database(dataPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      systemPrompt TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger TEXT NOT NULL,
      body TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      personaId TEXT,
      connectedAt INTEGER NOT NULL,
      lastActivity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default',
      ttl INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      channel TEXT,
      body TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spawns (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      persona_id TEXT,
      task TEXT,
      config_json TEXT,
      status TEXT NOT NULL DEFAULT 'spawning',
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      terminated_at INTEGER,
      exit_code INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory(namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_ttl ON memory(ttl);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_spawns_status ON spawns(status);
    CREATE INDEX IF NOT EXISTS idx_spawns_agent_id ON spawns(agent_id);
    CREATE TABLE IF NOT EXISTS beacon_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,  -- JSON string
      scope TEXT NOT NULL DEFAULT 'local',  -- 'local' or 'swarm' (synced to coordinator)
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      target_id TEXT,
      target_type TEXT,
      metadata TEXT,  -- JSON string
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_agent ON event_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);

    CREATE TABLE IF NOT EXISTS knowledge_cache (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_beacon_id TEXT,
      source_agent_id TEXT,
      confidence REAL DEFAULT 1.0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_cache_type ON knowledge_cache(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_cache_key ON knowledge_cache(key);

    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      insight TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local'
    );

    CREATE INDEX IF NOT EXISTS idx_insights_target ON insights(targetType, targetId);

    CREATE TABLE IF NOT EXISTS principles (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      principle TEXT NOT NULL,
      source TEXT,
      createdAt TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local'
    );

    CREATE INDEX IF NOT EXISTS idx_principles_target ON principles(targetType, targetId);
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'beacon',
      tags TEXT NOT NULL DEFAULT '[]',
      sources TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope ON wiki_pages(scope);
  `);

  logger.info('Beacon database initialized successfully');
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Beacon database closed');
  }
}

// === Persona Operations ===

export function createPersona(
  req: CreatePersonaRequest,
  scope: 'local' | 'coordinator' = 'local'
): Persona {
  const now = Date.now();
  const persona: Persona = {
    id: req.id,
    name: req.name,
    description: req.description,
    systemPrompt: req.systemPrompt,
    scope,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO personas (id, name, description, systemPrompt, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @systemPrompt, @scope, @createdAt, @updatedAt)
  `);

  stmt.run(persona);
  logger.info(`Created ${scope} persona: ${persona.id}`);
  return persona;
}

export function getPersona(id: string): Persona | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM personas WHERE id = ?');
  return stmt.get(id) as Persona | undefined;
}

export function listPersonas(): Persona[] {
  const stmt = getDatabase().prepare('SELECT * FROM personas ORDER BY name');
  return stmt.all() as Persona[];
}

export function listLocalPersonas(): Persona[] {
  const stmt = getDatabase().prepare(
    "SELECT * FROM personas WHERE scope = 'local' ORDER BY name"
  );
  return stmt.all() as Persona[];
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
    scope: existing.scope,
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
  const stmt = getDatabase().prepare('DELETE FROM personas WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted persona: ${id}`);
  return result.changes > 0;
}

export function upsertPersonaFromCoordinator(p: Persona): void {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO personas (id, name, description, systemPrompt, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @systemPrompt, @scope, @createdAt, @updatedAt)
  `);
  stmt.run(p);
  logger.info(`Synced coordinator persona: ${p.id}`);
}

// === Skill Operations ===

export function createSkill(
  req: CreateSkillRequest,
  scope: 'local' | 'coordinator' = 'local'
): Skill {
  const now = Date.now();
  const skill: Skill = {
    id: req.id,
    name: req.name,
    description: req.description,
    trigger: req.trigger,
    body: req.body,
    scope,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO skills (id, name, description, trigger, body, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @trigger, @body, @scope, @createdAt, @updatedAt)
  `);

  stmt.run(skill);
  logger.info(`Created ${scope} skill: ${skill.id}`);
  return skill;
}

export function getSkill(id: string): Skill | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM skills WHERE id = ?');
  return stmt.get(id) as Skill | undefined;
}

export function listSkills(): Skill[] {
  const stmt = getDatabase().prepare('SELECT * FROM skills ORDER BY name');
  return stmt.all() as Skill[];
}

export function listLocalSkills(): Skill[] {
  const stmt = getDatabase().prepare(
    "SELECT * FROM skills WHERE scope = 'local' ORDER BY name"
  );
  return stmt.all() as Skill[];
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
    scope: existing.scope,
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
  const stmt = getDatabase().prepare('DELETE FROM skills WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted skill: ${id}`);
  return result.changes > 0;
}

export function upsertSkillFromCoordinator(s: Skill): void {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO skills (id, name, description, trigger, body, scope, createdAt, updatedAt)
    VALUES (@id, @name, @description, @trigger, @body, @scope, @createdAt, @updatedAt)
  `);
  stmt.run(s);
  logger.info(`Synced coordinator skill: ${s.id}`);
}

// === Agent Session Operations ===

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
  const stmt = getDatabase().prepare(
    'SELECT * FROM agent_sessions WHERE id = ?'
  );
  return stmt.get(id) as AgentSession | undefined;
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

// === Memory Operations ===

export function createMemory(
  req: CreateMemoryRequest,
  namespace: string = 'default'
): Memory {
  const now = Date.now();
  const ttl = req.ttlSeconds ? now + req.ttlSeconds * 1000 : null;
  // Convert value to string if it's an object
  const value =
    typeof req.value === 'object' ? JSON.stringify(req.value) : req.value;
  const memory: Memory = {
    id: randomUUID(),
    key: req.key,
    value: value,
    namespace: req.namespace ?? namespace,
    ttl,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO memory (id, key, value, namespace, ttl, createdAt, updatedAt)
    VALUES (@id, @key, @value, @namespace, @ttl, @createdAt, @updatedAt)
  `);

  stmt.run(memory);
  logger.info(`Created memory: ${memory.key} (${memory.id})`);
  return memory;
}

export function getMemory(id: string): Memory | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM memory WHERE id = ?');
  return stmt.get(id) as Memory | undefined;
}

export function getMemoryByKey(
  key: string,
  namespace: string = 'default'
): Memory | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM memory WHERE key = ? AND namespace = ?'
  );
  return stmt.get(key, namespace) as Memory | undefined;
}

export function listMemories(
  namespace?: string,
  includeExpired: boolean = false
): Memory[] {
  let sql = 'SELECT * FROM memory';
  const params: (string | number)[] = [];

  if (namespace) {
    sql += ' WHERE namespace = ?';
    params.push(namespace);
  }

  if (!includeExpired) {
    sql += namespace ? ' AND' : ' WHERE';
    sql += ' (ttl IS NULL OR ttl > ?)';
    params.push(Date.now());
  }

  sql += ' ORDER BY key';

  const stmt = getDatabase().prepare(sql);
  return (params.length > 0 ? stmt.all(...params) : stmt.all()) as Memory[];
}

export function updateMemory(
  id: string,
  req: UpdateMemoryRequest
): Memory | undefined {
  const existing = getMemory(id);
  if (!existing) return undefined;

  const ttl =
    req.ttlSeconds !== undefined
      ? req.ttlSeconds > 0
        ? Date.now() + req.ttlSeconds * 1000
        : null
      : existing.ttl;

  const updated: Memory = {
    ...existing,
    key: req.key ?? existing.key,
    value:
      (typeof req.value === 'object' ? JSON.stringify(req.value) : req.value) ??
      existing.value,
    ttl,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE memory
    SET key = @key, value = @value, ttl = @ttl, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run(updated);
  logger.info(`Updated memory: ${id}`);
  return updated;
}

export function deleteMemory(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM memory WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted memory: ${id}`);
  return result.changes > 0;
}

export function cleanupExpiredMemories(): number {
  const now = Date.now();
  const stmt = getDatabase().prepare(
    'DELETE FROM memory WHERE ttl IS NOT NULL AND ttl <= ?'
  );
  const result = stmt.run(now);
  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} expired memories`);
  }
  return result.changes;
}

// Helper to check if memory is expired
export function isMemoryExpired(memory: Memory): boolean {
  return memory.ttl !== null && memory.ttl <= Date.now();
}

// === Message Operations ===

interface MessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  channel: string | null;
  body: string;
  delivered: number;
  created_at: number;
}

function rowToMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    channel: row.channel,
    body: row.body,
    delivered: row.delivered === 1,
    createdAt: row.created_at,
  };
}

export function createMessage(
  fromAgentId: string,
  toAgentId: string | null,
  channel: string | null,
  body: string
): AgentMessage {
  const now = Date.now();
  const id = randomUUID();

  const stmt = getDatabase().prepare(`
    INSERT INTO messages (id, from_agent_id, to_agent_id, channel, body, delivered, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `);

  stmt.run(id, fromAgentId, toAgentId, channel, body, now);

  logger.info(`Created message ${id} from ${fromAgentId}`);
  return {
    id,
    fromAgentId,
    toAgentId,
    channel,
    body,
    delivered: false,
    createdAt: now,
  };
}

export function getMessage(id: string): AgentMessage | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id) as MessageRow | undefined;
  if (!row) return undefined;
  return rowToMessage(row);
}

export function listMessagesForAgent(
  agentId: string,
  unreadOnly: boolean = true
): AgentMessage[] {
  const sql = unreadOnly
    ? 'SELECT * FROM messages WHERE to_agent_id = ? AND delivered = 0 ORDER BY created_at DESC'
    : 'SELECT * FROM messages WHERE to_agent_id = ? ORDER BY created_at DESC';
  const stmt = getDatabase().prepare(sql);
  return (stmt.all(agentId) as MessageRow[]).map(rowToMessage);
}

export function listMessagesByChannel(channel: string): AgentMessage[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM messages WHERE channel = ? ORDER BY created_at DESC'
  );
  return (stmt.all(channel) as MessageRow[]).map(rowToMessage);
}

export function markMessageDelivered(id: string): boolean {
  const stmt = getDatabase().prepare(
    'UPDATE messages SET delivered = 1 WHERE id = ?'
  );
  const result = stmt.run(id);
  if (result.changes > 0) logger.info(`Marked message ${id} delivered`);
  return result.changes > 0;
}

export function cleanupOldMessages(maxAgeHours: number = 24): number {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const stmt = getDatabase().prepare(
    'DELETE FROM messages WHERE delivered = 1 AND created_at < ?'
  );
  const result = stmt.run(cutoff);
  if (result.changes > 0)
    logger.info(`Cleaned up ${result.changes} old messages`);
  return result.changes;
}

// === Spawn Operations ===

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
  const stmt = getDatabase().prepare('DELETE FROM spawns WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted spawn: ${id}`);
  return result.changes > 0;
}

export function getSpawnByAgentId(agentId: string): SpawnRecord | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM spawns WHERE agent_id = ?');
  const row = stmt.get(agentId) as SpawnRow | undefined;
  if (!row) return undefined;
  return rowToSpawnRecord(row);
}
// ---------------------------------------------------------------------------
// Beacon Config CRUD
// ---------------------------------------------------------------------------

export interface BeaconConfigEntry {
  key: string;
  value: string; // JSON string
  scope: 'local' | 'swarm';
  createdAt: number;
  updatedAt: number;
}

export interface CreateConfigRequest {
  key: string;
  value: string; // JSON string
  scope?: 'local' | 'swarm'; // default: "local"
}

export function createBeaconConfig(
  req: CreateConfigRequest
): BeaconConfigEntry {
  const now = Date.now();
  const scope = req.scope ?? 'local';
  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_config (key, value, scope, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(req.key, req.value, scope, now, now);
  logger.info(`Created beacon config: ${req.key} (scope: ${scope})`);
  return {
    key: req.key,
    value: req.value,
    scope,
    createdAt: now,
    updatedAt: now,
  };
}

export function getBeaconConfig(key: string): BeaconConfigEntry | null {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config WHERE key = ?'
  );
  return stmt.get(key) as BeaconConfigEntry | null;
}

export function listBeaconConfig(): BeaconConfigEntry[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config ORDER BY key'
  );
  return stmt.all() as BeaconConfigEntry[];
}

export function updateBeaconConfig(
  key: string,
  value: string
): BeaconConfigEntry | null {
  const existing = getBeaconConfig(key);
  if (!existing) {
    return null;
  }
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_config SET value = ?, updatedAt = ? WHERE key = ?
  `);
  stmt.run(value, now, key);
  logger.info(`Updated beacon config: ${key}`);
  return getBeaconConfig(key);
}

export function deleteBeaconConfig(key: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM beacon_config WHERE key = ?');
  const result = stmt.run(key);
  logger.info(`Deleted beacon config: ${key}`);
  return result.changes > 0;
}

// === Event Log Operations ===

function rowToEventLog(row: {
  id: string;
  event_type: string;
  agent_id: string | null;
  target_id: string | null;
  target_type: string | null;
  metadata: string | null;
  timestamp: number;
}): EventLog {
  return {
    id: row.id,
    eventType: row.event_type as EventType,
    agentId: row.agent_id,
    targetId: row.target_id,
    targetType: row.target_type,
    metadata: row.metadata,
    timestamp: row.timestamp,
  };
}

export function createEventLog(req: CreateEventLogRequest): EventLog {
  const now = Date.now();
  const id = randomUUID();
  const eventLog: EventLog = {
    id,
    eventType: req.eventType,
    agentId: req.agentId ?? null,
    targetId: req.targetId ?? null,
    targetType: req.targetType ?? null,
    metadata: req.metadata ? JSON.stringify(req.metadata) : null,
    timestamp: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO event_log (id, event_type, agent_id, target_id, target_type, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    eventLog.eventType,
    eventLog.agentId,
    eventLog.targetId,
    eventLog.targetType,
    eventLog.metadata,
    eventLog.timestamp
  );
  return eventLog;
}

export function getEventLog(id: string): EventLog | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM event_log WHERE id = ?');
  const row = stmt.get(id) as
    | {
        id: string;
        event_type: string;
        agent_id: string | null;
        target_id: string | null;
        target_type: string | null;
        metadata: string | null;
        timestamp: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToEventLog(row);
}

export interface ListEventLogsOptions {
  agentId?: string;
  eventType?: EventType;
  since?: number;
  limit?: number;
}

export function listEventLogs(options: ListEventLogsOptions = {}): EventLog[] {
  const { agentId, eventType, since, limit = 100 } = options;

  let sql = 'SELECT * FROM event_log WHERE 1=1';
  const params: (string | number)[] = [];

  if (agentId) {
    sql += ' AND agent_id = ?';
    params.push(agentId);
  }

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }

  if (since) {
    sql += ' AND timestamp >= ?';
    params.push(since);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const stmt = getDatabase().prepare(sql);
  const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
    id: string;
    event_type: string;
    agent_id: string | null;
    target_id: string | null;
    target_type: string | null;
    metadata: string | null;
    timestamp: number;
  }>;

  return rows.map(rowToEventLog);
}

export function cleanupOldEventLogs(maxAgeDays: number = 30): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const stmt = getDatabase().prepare(
    'DELETE FROM event_log WHERE timestamp < ?'
  );
  const result = stmt.run(cutoff);
  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old event logs`);
  }
  return result.changes;
}

// === Knowledge Cache Operations ===

function rowToKnowledge(row: {
  id: string;
  type: string;
  key: string;
  value: string;
  source_beacon_id: string | null;
  source_agent_id: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}): Knowledge {
  return {
    id: row.id,
    type: row.type as Knowledge['type'],
    key: row.key,
    value: row.value,
    sourceBeaconId: row.source_beacon_id,
    sourceAgentId: row.source_agent_id,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function cacheKnowledge(knowledge: Knowledge): void {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO knowledge_cache (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
    VALUES (@id, @type, @key, @value, @sourceBeaconId, @sourceAgentId, @confidence, @createdAt, @updatedAt)
  `);

  stmt.run({
    id: knowledge.id,
    type: knowledge.type,
    key: knowledge.key,
    value: knowledge.value,
    sourceBeaconId: knowledge.sourceBeaconId,
    sourceAgentId: knowledge.sourceAgentId,
    confidence: knowledge.confidence,
    createdAt: knowledge.createdAt,
    updatedAt: knowledge.updatedAt,
  });
}

export function getCachedKnowledge(id: string): Knowledge | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM knowledge_cache WHERE id = ?'
  );
  const row = stmt.get(id) as
    | {
        id: string;
        type: string;
        key: string;
        value: string;
        source_beacon_id: string | null;
        source_agent_id: string | null;
        confidence: number;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToKnowledge(row);
}

export function listCachedKnowledge(type?: string): Knowledge[] {
  let stmt;
  if (type) {
    stmt = getDatabase().prepare(
      'SELECT * FROM knowledge_cache WHERE type = ? ORDER BY key'
    );
    return (
      stmt.all(type) as Array<{
        id: string;
        type: string;
        key: string;
        value: string;
        source_beacon_id: string | null;
        source_agent_id: string | null;
        confidence: number;
        createdAt: number;
        updatedAt: number;
      }>
    ).map(rowToKnowledge);
  }
  stmt = getDatabase().prepare(
    'SELECT * FROM knowledge_cache ORDER BY type, key'
  );
  return (
    stmt.all() as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      source_beacon_id: string | null;
      source_agent_id: string | null;
      confidence: number;
      createdAt: number;
      updatedAt: number;
    }>
  ).map(rowToKnowledge);
}

export function clearKnowledgeCache(): void {
  getDatabase().prepare('DELETE FROM knowledge_cache').run();
  logger.info('Cleared knowledge cache');
}

export function replaceKnowledgeCache(knowledge: Knowledge[]): void {
  const db = getDatabase();
  const clear = db.prepare('DELETE FROM knowledge_cache');
  const insert = db.prepare(`
    INSERT INTO knowledge_cache (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
    VALUES (@id, @type, @key, @value, @sourceBeaconId, @sourceAgentId, @confidence, @createdAt, @updatedAt)
  `);

  const transaction = db.transaction((items: Knowledge[]) => {
    clear.run();
    for (const k of items) {
      insert.run({
        id: k.id,
        type: k.type,
        key: k.key,
        value: k.value,
        sourceBeaconId: k.sourceBeaconId,
        sourceAgentId: k.sourceAgentId,
        confidence: k.confidence,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
      });
    }
  });

  transaction(knowledge);
  logger.info(`Replaced knowledge cache with ${knowledge.length} entries`);
}

// === Insight Operations ====

export interface InsightRow {
  id: string;
  targetType: string;
  targetId: string;
  insight: string;
  timestamp: string;
  scope: string;
}

export function createInsight(
  targetType: string,
  targetId: string,
  insight: string,
  scope: string = 'local'
): InsightRow {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const row: InsightRow = {
    id,
    targetType,
    targetId,
    insight,
    timestamp,
    scope,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO insights (id, targetType, targetId, insight, timestamp, scope)
    VALUES (@id, @targetType, @targetId, @insight, @timestamp, @scope)
  `);
  stmt.run(row);
  logger.info(`Created insight for ${targetType} "${targetId}"`);
  return row;
}

export function listInsights(
  targetType?: string,
  targetId?: string
): InsightRow[] {
  let sql = 'SELECT * FROM insights WHERE 1=1';
  const params: string[] = [];

  if (targetType) {
    sql += ' AND targetType = ?';
    params.push(targetType);
  }
  if (targetId) {
    sql += ' AND targetId = ?';
    params.push(targetId);
  }

  sql += ' ORDER BY timestamp DESC';
  const stmt = getDatabase().prepare(sql);
  return (params.length > 0 ? stmt.all(...params) : stmt.all()) as InsightRow[];
}

export function getInsight(id: string): InsightRow | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM insights WHERE id = ?');
  return stmt.get(id) as InsightRow | undefined;
}

export function deleteInsight(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM insights WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted insight: ${id}`);
  return result.changes > 0;
}

// === Principle Operations ====

export interface PrincipleRow {
  id: string;
  targetType: string;
  targetId: string;
  principle: string;
  source: string | null;
  createdAt: string;
  scope: string;
}

export function createPrinciple(
  targetType: string,
  targetId: string,
  principle: string,
  source?: string,
  scope: string = 'local'
): PrincipleRow {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const row: PrincipleRow = {
    id,
    targetType,
    targetId,
    principle,
    source: source ?? null,
    createdAt,
    scope,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO principles (id, targetType, targetId, principle, source, createdAt, scope)
    VALUES (@id, @targetType, @targetId, @principle, @source, @createdAt, @scope)
  `);
  stmt.run(row);
  logger.info(`Created principle for ${targetType} "${targetId}"`);
  return row;
}

export function listPrinciples(
  targetType?: string,
  targetId?: string
): PrincipleRow[] {
  let sql = 'SELECT * FROM principles WHERE 1=1';
  const params: string[] = [];

  if (targetType) {
    sql += ' AND targetType = ?';
    params.push(targetType);
  }
  if (targetId) {
    sql += ' AND targetId = ?';
    params.push(targetId);
  }

  sql += ' ORDER BY createdAt DESC';
  const stmt = getDatabase().prepare(sql);
  return (
    params.length > 0 ? stmt.all(...params) : stmt.all()
  ) as PrincipleRow[];
}

export function getPrinciple(id: string): PrincipleRow | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM principles WHERE id = ?');
  return stmt.get(id) as PrincipleRow | undefined;
}

export function deletePrinciple(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM principles WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted principle: ${id}`);
  return result.changes > 0;
}
