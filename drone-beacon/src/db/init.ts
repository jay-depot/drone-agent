import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

// Load sqlite-vec via its CJS entry. The ESM entry resolves the platform
// extension with `import.meta.resolve`, which under pnpm's store layout can
// double the `.so` suffix (vec0.so.so) and fail to load. The CJS entry uses
// `require.resolve`, which resolves the correct path.
const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec') as {
  load: (db: Database.Database) => void;
};

let db: Database.Database | null = null;

export function initDatabase(dataPath: string): Database.Database {
  logger.info(`Initializing database at: ${dataPath}`);
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  db = new Database(dataPath);
  sqliteVec.load(db);

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
      status TEXT NOT NULL DEFAULT 'connected',
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

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      body TEXT,
      createdAt INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastAttemptAt INTEGER,
      lastError TEXT,
      deliveredAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_undelivered ON outbox (createdAt)
      WHERE deliveredAt IS NULL;

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
      lastExamined TEXT,
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

    CREATE TABLE IF NOT EXISTS search_directories (
      agent_id TEXT NOT NULL,
      directory_path TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, directory_path)
    );

    CREATE TABLE IF NOT EXISTS search_files (
      id TEXT PRIMARY KEY,
      directory_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      last_indexed INTEGER NOT NULL,
      UNIQUE(directory_path, file_path)
    );

    CREATE TABLE IF NOT EXISTS search_chunks (
      id TEXT PRIMARY KEY,
      directory_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_files_dir ON search_files(directory_path);
    CREATE INDEX IF NOT EXISTS idx_search_chunks_dir ON search_chunks(directory_path);
    CREATE INDEX IF NOT EXISTS idx_search_directories_agent ON search_directories(agent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding FLOAT[768] distance_metric=cosine
    );

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

  // Idempotent migration: add lastExamined to existing insights tables.
  const insightCols = db.prepare('PRAGMA table_info(insights)').all() as Array<{
    name: string;
  }>;
  if (!insightCols.some(c => c.name === 'lastExamined')) {
    db.exec('ALTER TABLE insights ADD COLUMN lastExamined TEXT');
  }

  // Idempotent migration: add status to existing agent_sessions tables.
  const agentCols = db
    .prepare('PRAGMA table_info(agent_sessions)')
    .all() as Array<{
    name: string;
  }>;
  if (!agentCols.some(c => c.name === 'status')) {
    db.exec(
      "ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'connected'"
    );
  }

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
