import Database from 'better-sqlite3';
import type {
  Persona,
  Skill,
  Beacon,
  CreatePersonaRequest,
  CreateSkillRequest,
  RegisterBeaconRequest,
  RegisterBeaconTrustRequest,
  BeaconTrust,
  BeaconTrustStatus,
  BeaconSession,
  CreateSessionRequest,
  Knowledge,
  CreateKnowledgeRequest,
} from './types.js';
import { logger } from './logger.js';

let db: Database.Database | null = null;

export function initDatabase(dataPath: string): Database.Database {
  logger.info(`Initializing database at: ${dataPath}`);
  db = new Database(dataPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      systemPrompt TEXT NOT NULL,
      scope TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger TEXT NOT NULL,
      body TEXT NOT NULL,
      scope TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS beacons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      connectedAt INTEGER NOT NULL,
      lastHeartbeat INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS beacon_sessions (
      id TEXT PRIMARY KEY,
      beacon_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      persona_id TEXT,
      connected_at INTEGER NOT NULL,
      disconnected_at INTEGER,
      duration_ms INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (beacon_id) REFERENCES beacons(id)
    );

    CREATE INDEX IF NOT EXISTS idx_beacon_sessions_beacon ON beacon_sessions(beacon_id);
    CREATE INDEX IF NOT EXISTS idx_beacon_sessions_agent ON beacon_sessions(agent_id);
    CREATE TABLE IF NOT EXISTS beacon_trust (
      beacon_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      approval_token TEXT,
      approved_at INTEGER,
      tls_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge (
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

    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_key ON knowledge(key);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source_beacon_id);
  `);

  logger.info('Database initialized successfully');
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
    logger.info('Database closed');
  }
}

// Persona operations
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
  const stmt = getDatabase().prepare('SELECT * FROM personas WHERE id = ?');
  return stmt.get(id) as Persona | undefined;
}

export function listPersonas(): Persona[] {
  const stmt = getDatabase().prepare('SELECT * FROM personas ORDER BY name');
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

// Skill operations
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
  const stmt = getDatabase().prepare('SELECT * FROM skills WHERE id = ?');
  return stmt.get(id) as Skill | undefined;
}

export function listSkills(): Skill[] {
  const stmt = getDatabase().prepare('SELECT * FROM skills ORDER BY name');
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

// Beacon operations
export function registerBeacon(req: RegisterBeaconRequest): Beacon {
  const now = Date.now();
  const beacon: Beacon = {
    id: req.id,
    name: req.name,
    host: req.host,
    port: req.port,
    connectedAt: now,
    lastHeartbeat: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO beacons (id, name, host, port, connectedAt, lastHeartbeat)
    VALUES (@id, @name, @host, @port, @connectedAt, @lastHeartbeat)
  `);

  stmt.run(beacon);
  logger.info(`Registered beacon: ${beacon.id}`);
  return beacon;
}

export function getBeacon(id: string): Beacon | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM beacons WHERE id = ?');
  return stmt.get(id) as Beacon | undefined;
}

export function listBeacons(): Beacon[] {
  const stmt = getDatabase().prepare('SELECT * FROM beacons ORDER BY name');
  return stmt.all() as Beacon[];
}

export function heartbeatBeacon(id: string): Beacon | undefined {
  const beacon = getBeacon(id);
  if (!beacon) return undefined;

  beacon.lastHeartbeat = Date.now();

  const stmt = getDatabase().prepare(`
    UPDATE beacons SET lastHeartbeat = @lastHeartbeat WHERE id = @id
  `);

  stmt.run(beacon);
  return beacon;
}

export function deleteBeacon(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM beacons WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted beacon: ${id}`);
  return result.changes > 0;
}

// Beacon Trust operations
function generateApprovalToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function registerBeaconTrust(req: RegisterBeaconTrustRequest): BeaconTrust {
  const now = Date.now();
  const isLocal = req.host === 'localhost' || req.host === '127.0.0.1';
  
  // Auto-approve local beacons
  const status: BeaconTrustStatus = isLocal ? 'approved' : 'pending';
  const approvalToken = isLocal ? null : generateApprovalToken();
  
  const trust: BeaconTrust = {
    beaconId: req.id,
    name: req.name,
    publicKey: req.publicKey,
    host: req.host,
    port: req.port,
    status,
    approvalToken,
    approvedAt: isLocal ? now : null,
    tlsFingerprint: req.tlsFingerprint ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO beacon_trust 
    (beacon_id, name, public_key, host, port, status, approval_token, approved_at, tls_fingerprint, created_at, updated_at)
    VALUES (@beaconId, @name, @publicKey, @host, @port, @status, @approvalToken, @approvedAt, @tlsFingerprint, @createdAt, @updatedAt)
  `);

  stmt.run({
    beaconId: trust.beaconId,
    name: trust.name,
    publicKey: trust.publicKey,
    host: trust.host,
    port: trust.port,
    status: trust.status,
    approvalToken: trust.approvalToken,
    approvedAt: trust.approvedAt,
    tlsFingerprint: trust.tlsFingerprint,
    createdAt: trust.createdAt,
    updatedAt: trust.updatedAt,
  });

  logger.info(`Registered beacon trust: ${trust.beaconId} (status: ${trust.status})`);
  return trust;
}

export function getBeaconTrust(beaconId: string): BeaconTrust | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM beacon_trust WHERE beacon_id = ?');
  const row = stmt.get(beaconId) as {
    beacon_id: string;
    name: string;
    public_key: string;
    host: string;
    port: number;
    status: BeaconTrustStatus;
    approval_token: string | null;
    approved_at: number | null;
    tls_fingerprint: string | null;
    created_at: number;
    updated_at: number;
  } | undefined;
  if (!row) return undefined;
  return {
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBeaconTrust(): BeaconTrust[] {
  const stmt = getDatabase().prepare('SELECT * FROM beacon_trust ORDER BY name');
  const rows = stmt.all() as Array<{
    beacon_id: string;
    name: string;
    public_key: string;
    host: string;
    port: number;
    status: BeaconTrustStatus;
    approval_token: string | null;
    approved_at: number | null;
    tls_fingerprint: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map(row => ({
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function approveBeacon(approvalToken: string): BeaconTrust | null {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'approved', approval_token = NULL, approved_at = ?, updated_at = ?
    WHERE approval_token = ? AND status = 'pending'
  `);
  const result = stmt.run(now, now, approvalToken);
  
  if (result.changes === 0) {
    return null;
  }
  
  // Fetch and return the updated trust
  const stmt2 = getDatabase().prepare('SELECT * FROM beacon_trust WHERE approval_token = ?');
  const row = stmt2.get(approvalToken) as {
    beacon_id: string;
    name: string;
    public_key: string;
    host: string;
    port: number;
    status: BeaconTrustStatus;
    approval_token: string | null;
    approved_at: number | null;
    tls_fingerprint: string | null;
    created_at: number;
    updated_at: number;
  } | undefined;
  if (!row) return null;
  
  logger.info(`Approved beacon: ${row.beacon_id}`);
  return {
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rejectBeacon(beaconId: string): boolean {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'rejected', approval_token = NULL, updated_at = ?
    WHERE beacon_id = ?
  `);
  const result = stmt.run(now, beaconId);
  if (result.changes > 0) {
    logger.info(`Rejected beacon: ${beaconId}`);
  }
  return result.changes > 0;
}

export function deleteBeaconTrust(beaconId: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM beacon_trust WHERE beacon_id = ?');
  const result = stmt.run(beaconId);
  logger.info(`Deleted beacon trust: ${beaconId}`);
  return result.changes > 0;
}


// Beacon Session operations
function rowToBeaconSession(row: {
  id: string;
  beacon_id: string;
  agent_id: string;
  persona_id: string | null;
  connected_at: number;
  disconnected_at: number | null;
  duration_ms: number | null;
  createdAt: number;
  updatedAt: number;
}): BeaconSession {
  return {
    id: row.id,
    beaconId: row.beacon_id,
    agentId: row.agent_id,
    personaId: row.persona_id,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    durationMs: row.duration_ms,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBeaconSession(
  beaconId: string,
  req: CreateSessionRequest
): BeaconSession {
  const now = Date.now();
  const session: BeaconSession = {
    id: req.id,
    beaconId,
    agentId: req.agentId,
    personaId: req.personaId ?? null,
    connectedAt: now,
    disconnectedAt: null,
    durationMs: null,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_sessions (id, beacon_id, agent_id, persona_id, connected_at, disconnected_at, duration_ms, createdAt, updatedAt)
    VALUES (@id, @beaconId, @agentId, @personaId, @connectedAt, @disconnectedAt, @durationMs, @createdAt, @updatedAt)
  `);

  stmt.run({
    id: session.id,
    beaconId: session.beaconId,
    agentId: session.agentId,
    personaId: session.personaId,
    connectedAt: session.connectedAt,
    disconnectedAt: session.disconnectedAt,
    durationMs: session.durationMs,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });

  logger.info(
    `Created beacon session: ${session.id} for agent ${session.agentId}`
  );
  return session;
}

export function getBeaconSession(
  beaconId: string,
  agentId: string
): BeaconSession | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ? AND disconnected_at IS NULL'
  );
  const row = stmt.get(beaconId, agentId) as
    | {
        id: string;
        beacon_id: string;
        agent_id: string;
        persona_id: string | null;
        connected_at: number;
        disconnected_at: number | null;
        duration_ms: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToBeaconSession(row);
}

export function listBeaconSessions(beaconId: string): BeaconSession[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? ORDER BY connected_at DESC'
  );
  const rows = stmt.all(beaconId) as Array<{
    id: string;
    beacon_id: string;
    agent_id: string;
    persona_id: string | null;
    connected_at: number;
    disconnected_at: number | null;
    duration_ms: number | null;
    createdAt: number;
    updatedAt: number;
  }>;
  return rows.map(rowToBeaconSession);
}

export function endBeaconSession(
  beaconId: string,
  agentId: string,
  disconnectedAt: number,
  durationMs: number
): BeaconSession | undefined {
  const existing = getBeaconSession(beaconId, agentId);
  if (!existing) return undefined;

  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_sessions 
    SET disconnected_at = ?, duration_ms = ?, updatedAt = ?
    WHERE beacon_id = ? AND agent_id = ? AND disconnected_at IS NULL
  `);

  stmt.run(disconnectedAt, durationMs, now, beaconId, agentId);
  logger.info(
    `Ended beacon session for agent ${agentId}, duration: ${durationMs}ms`
  );

  // Fetch and return updated session
  const stmt2 = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ?'
  );
  const row = stmt2.get(beaconId, agentId) as
    | {
        id: string;
        beacon_id: string;
        agent_id: string;
        persona_id: string | null;
        connected_at: number;
        disconnected_at: number | null;
        duration_ms: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToBeaconSession(row);
}

export function deleteBeaconSession(
  beaconId: string,
  agentId: string
): boolean {
  const stmt = getDatabase().prepare(
    'DELETE FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ?'
  );
  const result = stmt.run(beaconId, agentId);
  logger.info(`Deleted beacon session for agent ${agentId}`);
  return result.changes > 0;
}

// === Knowledge operations ===

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

export function createKnowledge(req: CreateKnowledgeRequest): Knowledge {
  const now = Date.now();
  const knowledge: Knowledge = {
    id: req.id,
    type: req.type,
    key: req.key,
    value: req.value,
    sourceBeaconId: req.sourceBeaconId ?? null,
    sourceAgentId: req.sourceAgentId ?? null,
    confidence: req.confidence ?? 1.0,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO knowledge (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
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

  logger.info(`Created knowledge: ${knowledge.id} (${knowledge.type}:${knowledge.key})`);
  return knowledge;
}

export function getKnowledge(id: string): Knowledge | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM knowledge WHERE id = ?');
  const row = stmt.get(id) as {
    id: string;
    type: string;
    key: string;
    value: string;
    source_beacon_id: string | null;
    source_agent_id: string | null;
    confidence: number;
    createdAt: number;
    updatedAt: number;
  } | undefined;
  if (!row) return undefined;
  return rowToKnowledge(row);
}

export function listKnowledge(type?: string): Knowledge[] {
  let stmt;
  if (type) {
    stmt = getDatabase().prepare('SELECT * FROM knowledge WHERE type = ? ORDER BY key');
    return (stmt.all(type) as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      source_beacon_id: string | null;
      source_agent_id: string | null;
      confidence: number;
      createdAt: number;
      updatedAt: number;
    }>).map(rowToKnowledge);
  }
  stmt = getDatabase().prepare('SELECT * FROM knowledge ORDER BY type, key');
  return (stmt.all() as Array<{
    id: string;
    type: string;
    key: string;
    value: string;
    source_beacon_id: string | null;
    source_agent_id: string | null;
    confidence: number;
    createdAt: number;
    updatedAt: number;
  }>).map(rowToKnowledge);
}

export function updateKnowledge(
  id: string,
  req: { type?: string; key?: string; value?: string; confidence?: number }
): Knowledge | undefined {
  const existing = getKnowledge(id);
  if (!existing) return undefined;

  const updated: Knowledge = {
    ...existing,
    type: (req.type ?? existing.type) as Knowledge['type'],
    key: req.key ?? existing.key,
    value: req.value ?? existing.value,
    confidence: req.confidence ?? existing.confidence,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE knowledge 
    SET type = @type, key = @key, value = @value, confidence = @confidence, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run({
    id: updated.id,
    type: updated.type,
    key: updated.key,
    value: updated.value,
    confidence: updated.confidence,
    updatedAt: updated.updatedAt,
  });

  logger.info(`Updated knowledge: ${id}`);
  return updated;
}

export function deleteKnowledge(id: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM knowledge WHERE id = ?');
  const result = stmt.run(id);
  logger.info(`Deleted knowledge: ${id}`);
  return result.changes > 0;
}

export function searchKnowledge(query: string, type?: string): Knowledge[] {
  let stmt;
  const searchPattern = `%${query}%`;
  
  if (type) {
    stmt = getDatabase().prepare(`
      SELECT * FROM knowledge 
      WHERE type = ? AND (key LIKE ? OR value LIKE ?)
      ORDER BY confidence DESC
    `);
    return (stmt.all(type, searchPattern, searchPattern) as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      source_beacon_id: string | null;
      source_agent_id: string | null;
      confidence: number;
      createdAt: number;
      updatedAt: number;
    }>).map(rowToKnowledge);
  }
  
  stmt = getDatabase().prepare(`
    SELECT * FROM knowledge 
    WHERE key LIKE ? OR value LIKE ?
    ORDER BY confidence DESC
  `);
  return (stmt.all(searchPattern, searchPattern) as Array<{
    id: string;
    type: string;
    key: string;
    value: string;
    source_beacon_id: string | null;
    source_agent_id: string | null;
    confidence: number;
    createdAt: number;
    updatedAt: number;
  }>).map(rowToKnowledge);
}

export function upsertKnowledge(req: CreateKnowledgeRequest): Knowledge {
  // Check if knowledge with same type+key already exists
  const stmt = getDatabase().prepare('SELECT * FROM knowledge WHERE type = ? AND key = ?');
  const existing = stmt.get(req.type, req.key) as {
    id: string;
    type: string;
    key: string;
    value: string;
    source_beacon_id: string | null;
    source_agent_id: string | null;
    confidence: number;
    createdAt: number;
    updatedAt: number;
  } | undefined;

  if (existing) {
    // Conflict resolution: keep highest confidence or latest timestamp
    const newConfidence = req.confidence ?? 1.0;
    if (newConfidence > existing.confidence) {
      // New knowledge has higher confidence, update
      return updateKnowledge(existing.id, {
        value: req.value,
        confidence: newConfidence,
      })!;
    }
    // Keep existing (higher or equal confidence)
    return rowToKnowledge(existing);
  }

  // No existing entry, create new
  return createKnowledge(req);
}
