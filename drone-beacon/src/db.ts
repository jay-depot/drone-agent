import Database from "better-sqlite3";
import type { Persona, Skill, AgentSession, CreatePersonaRequest, CreateSkillRequest, RegisterAgentRequest } from "./types.js";
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
  `);

  logger.info("Beacon database initialized successfully");
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
    logger.info("Beacon database closed");
  }
}

// === Persona Operations ===

export function createPersona(req: CreatePersonaRequest, scope: "local" | "coordinator" = "local"): Persona {
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
  const stmt = getDatabase().prepare("SELECT * FROM personas WHERE id = ?");
  return stmt.get(id) as Persona | undefined;
}

export function listPersonas(): Persona[] {
  const stmt = getDatabase().prepare("SELECT * FROM personas ORDER BY name");
  return stmt.all() as Persona[];
}

export function listLocalPersonas(): Persona[] {
  const stmt = getDatabase().prepare("SELECT * FROM personas WHERE scope = 'local' ORDER BY name");
  return stmt.all() as Persona[];
}

export function updatePersona(id: string, req: Partial<CreatePersonaRequest>): Persona | undefined {
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
  const stmt = getDatabase().prepare("DELETE FROM personas WHERE id = ?");
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

export function createSkill(req: CreateSkillRequest, scope: "local" | "coordinator" = "local"): Skill {
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
  const stmt = getDatabase().prepare("SELECT * FROM skills WHERE id = ?");
  return stmt.get(id) as Skill | undefined;
}

export function listSkills(): Skill[] {
  const stmt = getDatabase().prepare("SELECT * FROM skills ORDER BY name");
  return stmt.all() as Skill[];
}

export function listLocalSkills(): Skill[] {
  const stmt = getDatabase().prepare("SELECT * FROM skills WHERE scope = 'local' ORDER BY name");
  return stmt.all() as Skill[];
}

export function updateSkill(id: string, req: Partial<CreateSkillRequest>): Skill | undefined {
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
  const stmt = getDatabase().prepare("DELETE FROM skills WHERE id = ?");
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
  const stmt = getDatabase().prepare("SELECT * FROM agent_sessions WHERE id = ?");
  return stmt.get(id) as AgentSession | undefined;
}

export function listAgents(): AgentSession[] {
  const stmt = getDatabase().prepare("SELECT * FROM agent_sessions");
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
  const stmt = getDatabase().prepare("DELETE FROM agent_sessions WHERE id = ?");
  const result = stmt.run(id);
  logger.info(`Unregistered agent: ${id}`);
  return result.changes > 0;
}