import type { FastifyInstance } from "fastify";
import * as db from "./db.js";
import type { CreatePersonaRequest, CreateSkillRequest, RegisterAgentRequest, CreateMemoryRequest, UpdateMemoryRequest } from "./types.js";
import { createCoordinatorClient, type CoordinatorClient } from "./coordinator-client.js";
import type { CoordinatorConfig } from "./types.js";
import { logger } from "./logger.js";

let coordinatorClient: CoordinatorClient | undefined;

export function setCoordinatorClient(client: CoordinatorClient | undefined) {
  coordinatorClient = client;
}

function getCoordinatorClient(): CoordinatorClient | undefined {
  return coordinatorClient;
}

interface MemoryQuery {
  namespace?: string;
  includeExpired?: string;
}

export async function registerRoutes(app: FastifyInstance) {
  // Health check
  app.get("/health", async () => {
    return { status: "ok", timestamp: Date.now() };
  });

  // === Persona Routes ===
  
  // Create a local persona (beacon-scoped)
  app.post<{ Body: CreatePersonaRequest }>("/personas", async (request, reply) => {
    const persona = db.createPersona(request.body, "local");
    return reply.code(201).send(persona);
  });

  // List all personas (local + synced from coordinator)
  app.get("/personas", async () => {
    return db.listPersonas();
  });

  // Get a single persona
  app.get<{ Params: { id: string } }>("/personas/:id", async (request, reply) => {
    const persona = db.getPersona(request.params.id);
    if (!persona) {
      return reply.code(404).send({ error: "Persona not found" });
    }
    return persona;
  });

  // Update a local persona
  app.put<{ Params: { id: string }; Body: Partial<CreatePersonaRequest> }>("/personas/:id", async (request, reply) => {
    const persona = db.updatePersona(request.params.id, request.body);
    if (!persona) {
      return reply.code(404).send({ error: "Persona not found" });
    }
    return persona;
  });

  // Delete a local persona
  app.delete<{ Params: { id: string } }>("/personas/:id", async (request, reply) => {
    const deleted = db.deletePersona(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: "Persona not found" });
    }
    return { success: true };
  });

  // === Skill Routes ===

  // Create a local skill
  app.post<{ Body: CreateSkillRequest }>("/skills", async (request, reply) => {
    const skill = db.createSkill(request.body, "local");
    return reply.code(201).send(skill);
  });

  // List all skills (local + synced from coordinator)
  app.get("/skills", async () => {
    return db.listSkills();
  });

  // Get a single skill
  app.get<{ Params: { id: string } }>("/skills/:id", async (request, reply) => {
    const skill = db.getSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: "Skill not found" });
    }
    return skill;
  });

  // Update a local skill
  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>("/skills/:id", async (request, reply) => {
    const skill = db.updateSkill(request.params.id, request.body);
    if (!skill) {
      return reply.code(404).send({ error: "Skill not found" });
    }
    return skill;
  });

  // Delete a local skill
  app.delete<{ Params: { id: string } }>("/skills/:id", async (request, reply) => {
    const deleted = db.deleteSkill(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: "Skill not found" });
    }
    return { success: true };
  });

  // === Agent Session Routes ===

  // Register an agent session
  app.post<{ Body: RegisterAgentRequest }>("/agents", async (request, reply) => {
    const session = db.registerAgent(request.body);
    return reply.code(201).send(session);
  });

  // List active agents
  app.get("/agents", async () => {
    return db.listAgents();
  });

  // Get agent info
  app.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const agent = db.getAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    return agent;
  });

  // Agent heartbeat
  app.post<{ Params: { id: string } }>("/agents/:id/heartbeat", async (request, reply) => {
    const agent = db.updateAgentActivity(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    return agent;
  });

  // Unregister agent
  app.delete<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const deleted = db.unregisterAgent(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    return { success: true };
  });

  // === Memory Routes ===

  // Create a memory
  app.post<{ Body: CreateMemoryRequest }>("/memory", async (request, reply) => {
    const memory = db.createMemory(request.body);
    return reply.code(201).send(memory);
  });

  // List memories (with optional namespace filter)
  app.get<{ Querystring: MemoryQuery }>("/memory", async (request, reply) => {
    const namespace = request.query.namespace;
    const includeExpired = request.query.includeExpired === "true";
    return db.listMemories(namespace, includeExpired);
  });

  // Get memory by ID
  app.get<{ Params: { id: string } }>("/memory/:id", async (request, reply) => {
    const memory = db.getMemory(request.params.id);
    if (!memory) {
      return reply.code(404).send({ error: "Memory not found" });
    }
    // Check if expired
    if (db.isMemoryExpired(memory)) {
      return reply.code(404).send({ error: "Memory not found (expired)" });
    }
    return memory;
  });

  // Get memory by key
  app.get<{ Params: { key: string }; Querystring: MemoryQuery }>("/memory/key/:key", async (request, reply) => {
    const namespace = request.query.namespace || "default";
    const memory = db.getMemoryByKey(request.params.key, namespace);
    if (!memory) {
      return reply.code(404).send({ error: "Memory not found" });
    }
    // Check if expired
    if (db.isMemoryExpired(memory)) {
      return reply.code(404).send({ error: "Memory not found (expired)" });
    }
    return memory;
  });

  // Update a memory
  app.put<{ Params: { id: string }; Body: Partial<UpdateMemoryRequest> }>("/memory/:id", async (request, reply) => {
    const memory = db.updateMemory(request.params.id, request.body);
    if (!memory) {
      return reply.code(404).send({ error: "Memory not found" });
    }
    return memory;
  });

  // Delete a memory
  app.delete<{ Params: { id: string } }>("/memory/:id", async (request, reply) => {
    const deleted = db.deleteMemory(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: "Memory not found" });
    }
    return { success: true };
  });

  // === Coordinator Sync Routes ===
  
  // Trigger a sync from coordinator
  app.post("/sync", async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(400).send({ error: "Coordinator not configured" });
    }

    try {
      // Fetch and sync personas
      const personas = await client.fetchPersonas();
      for (const p of personas) {
        db.upsertPersonaFromCoordinator(p);
      }

      // Fetch and sync skills
      const skills = await client.fetchSkills();
      for (const s of skills) {
        db.upsertSkillFromCoordinator(s);
      }

      return { 
        success: true, 
        synced: { 
          personas: personas.length, 
          skills: skills.length 
        } 
      };
    } catch (err) {
      logger.error(err, "Sync failed");
      return reply.code(500).send({ error: "Sync failed" });
    }
  });
}