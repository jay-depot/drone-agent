import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

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
      approved_at INTEGER,
      tls_fingerprint TEXT,
      verification_code TEXT,
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

    CREATE TABLE IF NOT EXISTS swarm_sessions (
      id TEXT PRIMARY KEY,
      persona_id TEXT,
      beacon_id TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS swarm_events (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      correlationId TEXT,
      type TEXT NOT NULL,
      payload TEXT,
      metadata TEXT,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES swarm_sessions(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS swarm_events_fts USING fts5(
      payload, content='swarm_events', content_rowid='id'
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_events_session ON swarm_events(sessionId);
    CREATE INDEX IF NOT EXISTS idx_swarm_events_correlation ON swarm_events(correlationId);

    CREATE TABLE IF NOT EXISTS agent_locations (
      agent_id TEXT PRIMARY KEY,
      beacon_id TEXT NOT NULL,
      persona_id TEXT,
      connected_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_locations_beacon ON agent_locations(beacon_id);

    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      insight TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      lastExamined TEXT,
      scope TEXT NOT NULL DEFAULT 'coordinator'
    );

    CREATE INDEX IF NOT EXISTS idx_insights_target ON insights(targetType, targetId);

    CREATE TABLE IF NOT EXISTS principles (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      principle TEXT NOT NULL,
      source TEXT,
      createdAt TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'coordinator'
    );

    CREATE INDEX IF NOT EXISTS idx_principles_target ON principles(targetType, targetId);

    CREATE TABLE IF NOT EXISTS web_token (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      defaultHidden INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_definitions_name ON tool_definitions(name);
  `);

  // Idempotent migration: add lastExamined to existing insights tables.
  const insightCols = db.prepare('PRAGMA table_info(insights)').all() as Array<{
    name: string;
  }>;
  if (!insightCols.some(c => c.name === 'lastExamined')) {
    db.exec('ALTER TABLE insights ADD COLUMN lastExamined TEXT');
  }

  // Idempotent migration for beacon_trust: add verification_code and drop
  // the obsolete approval_token column.
  const beaconTrustCols = db
    .prepare('PRAGMA table_info(beacon_trust)')
    .all() as Array<{ name: string }>;
  if (!beaconTrustCols.some(c => c.name === 'verification_code')) {
    db.exec('ALTER TABLE beacon_trust ADD COLUMN verification_code TEXT');
  }
  if (beaconTrustCols.some(c => c.name === 'approval_token')) {
    db.exec('ALTER TABLE beacon_trust DROP COLUMN approval_token');
  }

  // Seed built-in tool definitions
  seedBuiltinToolDefinitions();

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

// ── Built-in tool definition seeding ────────────────────────────────

const BUILTIN_HIDDEN_TOOLS: Array<{
  name: string;
  description: string;
}> = [
  {
    name: 'swarm__wiki_write',
    description: 'Create or update a wiki page in the swarm knowledge base',
  },
  {
    name: 'swarm__wiki_delete',
    description: 'Delete a wiki page from the swarm knowledge base',
  },
  {
    name: 'self-improvement__insights-list',
    description:
      'List all insight files with their entry counts and last timestamps',
  },
  {
    name: 'self-improvement__insights-recall',
    description: 'Read all insights for a specific target',
  },
  {
    name: 'self-improvement__principles-store',
    description: 'Store a principle',
  },
  {
    name: 'self-improvement__principles-delete',
    description: 'Delete a principle',
  },
];

/**
 * Seed built-in tool definitions that should be hidden by default.
 * Only inserts tools that don't already exist, so user customizations
 * and agent-pushed definitions are preserved.
 */
export function seedBuiltinToolDefinitions(): void {
  const existing = getToolDefinitions();
  const existingNames = new Set(existing.map(t => t.name));

  for (const tool of BUILTIN_HIDDEN_TOOLS) {
    if (!existingNames.has(tool.name)) {
      upsertToolDefinition(tool.name, tool.description, true, 'builtin');
      logger.info(`Seeded built-in hidden tool: ${tool.name}`);
    }
  }
}

// ── Tool Definition operations ──────────────────────────────────────

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  defaultHidden: number;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export function upsertToolDefinition(
  name: string,
  description: string,
  defaultHidden: boolean,
  source: string
): ToolDefinition {
  const now = Date.now();
  const id = name;
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO tool_definitions (id, name, description, defaultHidden, source, createdAt, updatedAt)
    VALUES (@id, @name, @description, @defaultHidden, @source, @createdAt, @updatedAt)
  `);
  stmt.run({
    id,
    name,
    description,
    defaultHidden: defaultHidden ? 1 : 0,
    source,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    name,
    description,
    defaultHidden: defaultHidden ? 1 : 0,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM tool_definitions ORDER BY name'
  );
  return stmt.all() as ToolDefinition[];
}

export function getDefaultHiddenTools(): ToolDefinition[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM tool_definitions WHERE defaultHidden = 1 ORDER BY name'
  );
  return stmt.all() as ToolDefinition[];
}
