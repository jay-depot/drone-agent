import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Persona, Skill, Beacon, CreatePersonaRequest, CreateSkillRequest, RegisterBeaconRequest } from "./types.js";
import { logger } from "./logger.js";

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
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger TEXT NOT NULL,
      body TEXT NOT NULL,
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
  `);

  logger.info("Database initialized successfully");
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info("Database closed");
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
    createdAt: now,
    updatedAt: now,
  };
  
  const stmt = getDatabase().prepare(`
    INSERT INTO personas (id, name, description, systemPrompt, createdAt, updatedAt)
    VALUES (@id, @name, @description, @systemPrompt, @createdAt, @updatedAt)
  `);
  
  stmt.run(persona);
  logger.info(`Created persona: ${persona.id}`);
  return persona;
}

export function getPersona(id: string): Persona | undefined {
  const stmt = getDatabase().prepare("SELECT * FROM personas WHERE id = ?");
  return stmt.get(id) as Persona | undefined;
}

export function listPersonas(): Persona[] {
  const stmt = getDatabase().prepare("SELECT * FROM personas ORDER BY name");
  return stmt.all() as Persona[];
}

export function updatePersona(id: string, req: Partial<CreatePersonaRequest>): Persona | undefined {
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
  const stmt = getDatabase().prepare("DELETE FROM personas WHERE id = ?");
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
    createdAt: now,
    updatedAt: now,
  };
  
  const stmt = getDatabase().prepare(`
    INSERT INTO skills (id, name, description, trigger, body, createdAt, updatedAt)
    VALUES (@id, @name, @description, @trigger, @body, @createdAt, @updatedAt)
  `);
  
  stmt.run(skill);
  logger.info(`Created skill: ${skill.id}`);
  return skill;
}

export function getSkill(id: string): Skill | undefined {
  const stmt = getDatabase().prepare("SELECT * FROM skills WHERE id = ?");
  return stmt.get(id) as Skill | undefined;
}

export function listSkills(): Skill[] {
  const stmt = getDatabase().prepare("SELECT * FROM skills ORDER BY name");
  return stmt.all() as Skill[];
}

export function updateSkill(id: string, req: Partial<CreateSkillRequest>): Skill | undefined {
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
  const stmt = getDatabase().prepare("DELETE FROM skills WHERE id = ?");
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
  const stmt = getDatabase().prepare("SELECT * FROM beacons WHERE id = ?");
  return stmt.get(id) as Beacon | undefined;
}

export function listBeacons(): Beacon[] {
  const stmt = getDatabase().prepare("SELECT * FROM beacons ORDER BY name");
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
  const stmt = getDatabase().prepare("DELETE FROM beacons WHERE id = ?");
  const result = stmt.run(id);
  logger.info(`Deleted beacon: ${id}`);
  return result.changes > 0;
}