import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as db from './db.js';
import * as spawner from './spawner.js';
import type {
  CreatePersonaRequest,
  CreateSkillRequest,
  RegisterAgentRequest,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  SpawnRequest,
  CreateMessageRequest,
} from './types.js';
import { type CoordinatorClient } from './coordinator-client.js';
import * as wsServer from './ws-server.js';
import { logger } from './logger.js';

let coordinatorClient: CoordinatorClient | undefined;
let beaconHost = 'localhost';
let beaconPort = 3457;

export function setCoordinatorClient(client: CoordinatorClient | undefined) {
  coordinatorClient = client;
}

function getCoordinatorClient(): CoordinatorClient | undefined {
  return coordinatorClient;
}

export function setBeaconAddress(host: string, port: number) {
  beaconHost = host;
  beaconPort = port;
}

function getBeaconUrl(): string {
  return `http://${beaconHost}:${beaconPort}`;
}

// Exported function for periodic sync (called from index.ts)
export async function triggerCoordinatorSync(): Promise<{
  success: boolean;
  synced?: { personas: number; skills: number; knowledge: number };
  error?: string;
}> {
  const client = getCoordinatorClient();
  if (!client) {
    return { success: false, error: 'Coordinator not configured' };
  }

  try {
    const personas = await client.fetchPersonas();
    for (const p of personas) {
      db.upsertPersonaFromCoordinator(p);
    }
    const skills = await client.fetchSkills();
    for (const s of skills) {
      db.upsertSkillFromCoordinator(s);
    }

    // Sync knowledge from coordinator
    let knowledgeCount = 0;
    try {
      const knowledge = await client.pullKnowledge();
      if (knowledge.length > 0) {
        db.replaceKnowledgeCache(knowledge);
        knowledgeCount = knowledge.length;
      }
    } catch (err) {
      logger.warn(`Knowledge sync failed: ${err}`);
    }

    logger.info(
      `Synced ${personas.length} personas, ${skills.length} skills, and ${knowledgeCount} knowledge entries from coordinator`
    );
    return {
      success: true,
      synced: {
        personas: personas.length,
        skills: skills.length,
        knowledge: knowledgeCount,
      },
    };
  } catch (err) {
    logger.error(err, 'Sync failed');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

interface MemoryQuery {
  namespace?: string;
  includeExpired?: string;
}

interface SpawnQuery {
  status?: string;
}

interface EventQuery {
  agentId?: string;
  eventType?: string;
  since?: string;
  limit?: string;
}

export async function registerRoutes(app: FastifyInstance) {
  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // === Persona Routes ===
  // Create a local persona (beacon-scoped)
  app.post<{ Body: CreatePersonaRequest }>(
    '/personas',
    async (request, reply) => {
      const persona = db.createPersona(request.body, 'local');

      // Sync to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client.pushPersona(persona).catch(err => {
          logger.warn(`Failed to push persona to coordinator: ${err}`);
        });
      }

      // Log the event
      db.createEventLog({
        eventType: 'persona.created',
        targetId: persona.id,
        targetType: 'persona',
      });

      return reply.code(201).send(persona);
    }
  );

  // List all personas (local + synced from coordinator)
  app.get('/personas', async () => {
    return db.listPersonas();
  });

  // Get a single persona
  app.get<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.getPersona(request.params.id);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return persona;
    }
  );

  // Update a local persona
  app.put<{ Params: { id: string }; Body: Partial<CreatePersonaRequest> }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.updatePersona(request.params.id, request.body);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }

      // Sync update to coordinator (only local scope)
      if (persona.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.pushPersona(persona).catch(err => {
            logger.warn(`Failed to push persona update to coordinator: ${err}`);
          });
        }
      }

      return persona;
    }
  );

  // Delete a local persona
  app.delete<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const existing = db.getPersona(request.params.id);
      const deleted = db.deletePersona(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Persona not found' });
      }

      // Sync delete to coordinator (only local scope)
      if (existing?.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.deletePersona(request.params.id).catch(err => {
            logger.warn(`Failed to delete persona from coordinator: ${err}`);
          });
        }
      }

      return { success: true };
    }
  );

  // === Skill Routes ===

  // Create a local skill
  app.post<{ Body: CreateSkillRequest }>('/skills', async (request, reply) => {
    const skill = db.createSkill(request.body, 'local');

    // Sync to coordinator
    const client = getCoordinatorClient();
    if (client) {
      client.pushSkill(skill).catch(err => {
        logger.warn(`Failed to push skill to coordinator: ${err}`);
      });
    }

    return reply.code(201).send(skill);
  });

  // List all skills (local + synced from coordinator)
  app.get('/skills', async () => {
    return db.listSkills();
  });

  // Get a single skill
  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const skill = db.getSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    return skill;
  });

  // Update a local skill
  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>(
    '/skills/:id',
    async (request, reply) => {
      const skill = db.updateSkill(request.params.id, request.body);
      if (!skill) {
        return reply.code(404).send({ error: 'Skill not found' });
      }

      // Sync update to coordinator (only local scope)
      if (skill.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.pushSkill(skill).catch(err => {
            logger.warn(`Failed to push skill update to coordinator: ${err}`);
          });
        }
      }

      return skill;
    }
  );

  // Delete a local skill
  app.delete<{ Params: { id: string } }>(
    '/skills/:id',
    async (request, reply) => {
      const existing = db.getSkill(request.params.id);
      const deleted = db.deleteSkill(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }

      // Sync delete to coordinator (only local scope)
      if (existing?.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.deleteSkill(request.params.id).catch(err => {
            logger.warn(`Failed to delete skill from coordinator: ${err}`);
          });
        }
      }

      return { success: true };
    }
  );

  // === Agent Session Routes ===

  // Register an agent session
  app.post<{ Body: RegisterAgentRequest }>(
    '/agents',
    async (request, reply) => {
      const session = db.registerAgent(request.body);

      // If this agent was spawned by the beacon, update the spawn record
      const spawnRecord = db.getSpawnByAgentId(request.body.id);
      if (spawnRecord) {
        db.updateSpawnStatus(spawnRecord.id, 'running', request.body.id);
        logger.info(
          `Spawn ${spawnRecord.id} agent connected: ${request.body.id}`
        );
      }

      // Sync session to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client
          .registerSession(request.body.id, request.body.personaId)
          .catch(err => {
            logger.warn(`Failed to sync session to coordinator: ${err}`);
          });
      }

      // Log the event
      db.createEventLog({
        eventType: 'agent.connected',
        agentId: request.body.id,
        targetId: spawnRecord?.id ?? null,
        targetType: spawnRecord ? 'spawn' : null,
      });

      return reply.code(201).send(session);
    }
  );

  // List active agents
  app.get('/agents', async () => {
    return db.listAgents();
  });

  // Get agent info
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const agent = db.getAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return agent;
  });

  // Agent heartbeat
  app.post<{ Params: { id: string } }>(
    '/agents/:id/heartbeat',
    async (request, reply) => {
      const agent = db.updateAgentActivity(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      return agent;
    }
  );

  // Unregister agent
  app.delete<{ Params: { id: string } }>(
    '/agents/:id',
    async (request, reply) => {
      // Get agent info before unregistering (for session sync)
      const agent = db.getAgent(request.params.id);
      const connectedAt = agent?.connectedAt ?? Date.now();

      const deleted = db.unregisterAgent(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      // Sync session end to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client.endSession(request.params.id, connectedAt).catch(err => {
          logger.warn(`Failed to sync session end to coordinator: ${err}`);
        });
      }

      // Log the event
      db.createEventLog({
        eventType: 'agent.disconnected',
        agentId: request.params.id,
        metadata: { connectedAt, durationMs: Date.now() - connectedAt },
      });
      return { success: true };
    }
  );

  // === Memory Routes ===

  // Create a memory
  app.post<{ Body: CreateMemoryRequest }>('/memory', async (request, reply) => {
    const memory = db.createMemory(request.body);
    return reply.code(201).send(memory);
  });

  // List memories (with optional namespace filter)
  app.get<{ Querystring: MemoryQuery }>('/memory', async (request, reply) => {
    const namespace = request.query.namespace;
    const includeExpired = request.query.includeExpired === 'true';
    return db.listMemories(namespace, includeExpired);
  });

  // Get memory by ID
  app.get<{ Params: { id: string } }>('/memory/:id', async (request, reply) => {
    const memory = db.getMemory(request.params.id);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }
    // Check if expired
    if (db.isMemoryExpired(memory)) {
      return reply.code(404).send({ error: 'Memory not found (expired)' });
    }
    return memory;
  });

  // Get memory by key
  app.get<{ Params: { key: string }; Querystring: MemoryQuery }>(
    '/memory/key/:key',
    async (request, reply) => {
      const namespace = request.query.namespace || 'default';
      const memory = db.getMemoryByKey(request.params.key, namespace);
      if (!memory) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      // Check if expired
      if (db.isMemoryExpired(memory)) {
        return reply.code(404).send({ error: 'Memory not found (expired)' });
      }
      // Parse the value back to object if it's JSON
      let parsedValue = memory.value;
      try {
        parsedValue = JSON.parse(memory.value);
      } catch {
        // Not JSON, keep as string
      }
      return { ...memory, value: parsedValue };
    }
  );

  // Update a memory
  app.put<{ Params: { id: string }; Body: Partial<UpdateMemoryRequest> }>(
    '/memory/:id',
    async (request, reply) => {
      const memory = db.updateMemory(request.params.id, request.body);
      if (!memory) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      return memory;
    }
  );

  // Delete a memory
  app.delete<{ Params: { id: string } }>(
    '/memory/:id',
    async (request, reply) => {
      const deleted = db.deleteMemory(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      return { success: true };
    }
  );

  // === Message Routes ===
  // Send a message (REST fallback for non-WS clients)
  // Updated to support cross-beacon messages via coordinator relay
  app.post<{ Body: CreateMessageRequest }>(
    '/messages',
    async (request, reply) => {
      const { fromAgentId, fromBeaconId, toAgentId, toChannel, body } =
        request.body;

      // Validate sender - either local agent or cross-beacon relay
      if (!fromAgentId) {
        return reply.code(400).send({ error: 'fromAgentId is required' });
      }

      // If fromBeaconId is present, this is a cross-beacon message
      // We don't require the sender to be a local agent
      const isLocalSender = !fromBeaconId;
      if (isLocalSender) {
        // Verify sender is registered locally
        const sender = db.getAgent(fromAgentId);
        if (!sender) {
          return reply
            .code(403)
            .send({ error: 'Sender agent not registered locally' });
        }
      }

      if (!toAgentId && !toChannel) {
        return reply
          .code(400)
          .send({ error: 'Must specify toAgentId or toChannel' });
      }

      const message = db.createMessage(
        fromAgentId,
        toAgentId ?? null,
        toChannel ?? null,
        body
      );

      // Try to deliver immediately if recipient is connected
      if (toAgentId && wsServer.isAgentConnected(toAgentId)) {
        wsServer.sendToAgent(toAgentId, {
          type: 'message',
          payload: {
            id: message.id,
            fromAgentId,
            fromBeaconId: fromBeaconId ?? null,
            body: JSON.parse(body),
            receivedAt: message.createdAt,
          },
        });
        db.markMessageDelivered(message.id);
      }

      return reply.code(201).send(message);
    }
  );

  // List messages for an agent
  app.get<{ Querystring: { agentId: string; unreadOnly?: string } }>(
    '/messages',
    async (request, reply) => {
      const { agentId, unreadOnly } = request.query;
      if (!agentId) {
        return reply
          .code(400)
          .send({ error: 'agentId query parameter required' });
      }
      return db.listMessagesForAgent(agentId, unreadOnly !== 'false');
    }
  );

  // Get single message
  app.get<{ Params: { id: string } }>(
    '/messages/:id',
    async (request, reply) => {
      const message = db.getMessage(request.params.id);
      if (!message) {
        return reply.code(404).send({ error: 'Message not found' });
      }
      return message;
    }
  );

  // Mark message as read
  app.post<{ Params: { id: string } }>(
    '/messages/:id/read',
    async (request, reply) => {
      const marked = db.markMessageDelivered(request.params.id);
      if (!marked) {
        return reply.code(404).send({ error: 'Message not found' });
      }
      return { success: true };
    }
  );

  // List messages in a channel
  app.get<{ Params: { channel: string } }>(
    '/messages/channel/:channel',
    async (request, reply) => {
      return db.listMessagesByChannel(request.params.channel);
    }
  );

  // === Spawn Routes ===
  // Spawn a new agent
  app.post<{ Body: SpawnRequest }>('/spawn', async (request, reply) => {
    const { personaId, task, config, spawnId } = request.body;

    // Validate persona exists if provided
    if (personaId) {
      const persona = db.getPersona(personaId);
      if (!persona) {
        return reply
          .code(400)
          .send({ error: `Persona not found: ${personaId}` });
      }
    }

    // Generate IDs
    const finalSpawnId = spawnId || randomUUID();
    const agentId = `agent-${randomUUID()}`;

    try {
      const spawnRecord = await spawner.spawnAgent(
        finalSpawnId,
        agentId,
        personaId ?? null,
        task ?? null,
        config
      );

      return reply.code(202).send({
        spawnId: spawnRecord.id,
        agentId: agentId,
        status: spawnRecord.status,
        beaconUrl: getBeaconUrl(),
        message: 'Agent spawned, waiting for connection',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Create a failed spawn record
      const spawnRecord = db.createSpawn(
        finalSpawnId,
        personaId ?? null,
        task ?? null,
        config ?? null
      );
      db.updateSpawnStatus(finalSpawnId, 'failed', null, message);
      return reply.code(202).send({
        spawnId: finalSpawnId,
        agentId: agentId,
        status: 'failed',
        beaconUrl: getBeaconUrl(),
        message,
      });
    }
  });

  // List spawns (with optional status filter)
  app.get<{ Querystring: SpawnQuery }>('/spawn', async (request, reply) => {
    const status = request.query.status;
    return db.listSpawns(status);
  });

  // Get spawn status
  app.get<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const spawn = db.getSpawn(request.params.spawnId);
      if (!spawn) {
        return reply.code(404).send({ error: 'Spawn not found' });
      }
      return {
        spawnId: spawn.id,
        agentId: spawn.agentId,
        status: spawn.status,
        createdAt: spawn.createdAt,
        startedAt: spawn.startedAt,
        terminatedAt: spawn.terminatedAt,
        exitCode: spawn.exitCode,
        error: spawn.error,
      };
    }
  );

  // Terminate a spawned agent
  app.delete<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const spawn = db.getSpawn(request.params.spawnId);
      if (!spawn) {
        return reply.code(404).send({ error: 'Spawn not found' });
      }

      // Check if agent is still running
      if (spawn.status !== 'running' && spawn.status !== 'spawning') {
        return reply
          .code(400)
          .send({ error: `Cannot terminate: agent status is ${spawn.status}` });
      }

      // Try to terminate the process
      const terminated = spawner.terminateAgent(request.params.spawnId, false);
      if (!terminated) {
        return reply
          .code(400)
          .send({ error: 'Failed to terminate agent process' });
      }

      return { success: true, message: 'Termination signal sent' };
    }
  );

  // === Coordinator Sync Routes ===
  // Trigger a sync from coordinator (manual endpoint)
  app.post('/sync', async (request, reply) => {
    const result = await triggerCoordinatorSync();
    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  });

  // === Config Routes ===

  // Get all beacon config overrides
  app.get('/config', async () => {
    return db.listBeaconConfig();
  });

  // Get specific config value
  app.get<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const config = db.getBeaconConfig(request.params.key);
      if (!config) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return config;
    }
  );

  // Set a config override
  app.post<{ Body: db.CreateConfigRequest }>(
    '/config',
    async (request, reply) => {
      const config = db.createBeaconConfig(request.body);
      return reply.code(201).send(config);
    }
  );

  // Update config override
  app.put<{ Params: { key: string }; Body: { value: string } }>(
    '/config/:key',
    async (request, reply) => {
      const config = db.updateBeaconConfig(
        request.params.key,
        request.body.value
      );
      if (!config) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return config;
    }
  );

  // Remove config override
  app.delete<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const deleted = db.deleteBeaconConfig(request.params.key);
      if (!deleted) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return { success: true };
    }
  );

  // === Event Log Routes ===
  // List event logs with optional filters
  app.get<{ Querystring: EventQuery }>('/events', async (request, reply) => {
    const agentId = request.query.agentId;
    const eventType = request.query
      .eventType as db.ListEventLogsOptions['eventType'];
    const since = request.query.since
      ? parseInt(request.query.since)
      : undefined;
    const limit = request.query.limit ? parseInt(request.query.limit) : 100;
    return db.listEventLogs({ agentId, eventType, since, limit });
  });

  // Get specific event log
  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    const eventLog = db.getEventLog(request.params.id);
    if (!eventLog) {
      return reply.code(404).send({ error: 'Event not found' });
    }
    return eventLog;
  });

  // === Insight Routes ===

  // Helper to proxy insight/principle requests to coordinator
  const proxyToCoordinator = async (
    method: string,
    path: string,
    body?: unknown
  ) => {
    const client = getCoordinatorClient();
    if (!client) {
      return null;
    }
    const url = `${client.getBaseUrl()}${path}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return res.json();
  };

  // Create an insight (local or coordinator)
  app.post<{
    Body: {
      targetType: string;
      targetId: string;
      insight: string;
      scope?: string;
    };
  }>('/insights', async (request, reply) => {
    const { targetType, targetId, insight, scope } = request.body;
    if (!targetType || !targetId || !insight) {
      return reply
        .code(400)
        .send({ error: 'targetType, targetId, and insight are required' });
    }

    if (scope === 'coordinator') {
      const result = await proxyToCoordinator(
        'POST',
        '/insights',
        request.body
      );
      if (!result) {
        return reply
          .code(502)
          .send({ error: 'Failed to proxy to coordinator' });
      }
      return reply.code(201).send(result);
    }

    const row = db.createInsight(targetType, targetId, insight, scope);
    return reply.code(201).send(row);
  });

  // List insights (with optional targetType, targetId, and scope filters)
  app.get<{
    Querystring: { targetType?: string; targetId?: string; scope?: string };
  }>('/insights', async request => {
    const { targetType, targetId, scope } = request.query;

    if (scope === 'coordinator') {
      const result = await proxyToCoordinator(
        'GET',
        `/insights?targetType=${targetType ?? ''}&targetId=${targetId ?? ''}`
      );
      return result ?? [];
    }

    return db.listInsights(targetType, targetId);
  });

  // Get a single insight
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/insights/:id',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyToCoordinator(
          'GET',
          `/insights/${request.params.id}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Insight not found' });
        }
        return result;
      }

      const row = db.getInsight(request.params.id);
      if (!row) {
        return reply.code(404).send({ error: 'Insight not found' });
      }
      return row;
    }
  );

  // Delete an insight
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/insights/:id',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyToCoordinator(
          'DELETE',
          `/insights/${request.params.id}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Insight not found' });
        }
        return result;
      }

      const deleted = db.deleteInsight(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Insight not found' });
      }
      return { success: true };
    }
  );

  // === Principle Routes ===

  // Create a principle (local or coordinator)
  app.post<{
    Body: {
      targetType: string;
      targetId: string;
      principle: string;
      source?: string;
      scope?: string;
    };
  }>('/principles', async (request, reply) => {
    const { targetType, targetId, principle, source, scope } = request.body;
    if (!targetType || !targetId || !principle) {
      return reply
        .code(400)
        .send({ error: 'targetType, targetId, and principle are required' });
    }

    if (scope === 'coordinator') {
      const result = await proxyToCoordinator(
        'POST',
        '/principles',
        request.body
      );
      if (!result) {
        return reply
          .code(502)
          .send({ error: 'Failed to proxy to coordinator' });
      }
      return reply.code(201).send(result);
    }

    const row = db.createPrinciple(
      targetType,
      targetId,
      principle,
      source,
      scope
    );
    return reply.code(201).send(row);
  });

  // List principles (with optional targetType, targetId, and scope filters)
  app.get<{
    Querystring: { targetType?: string; targetId?: string; scope?: string };
  }>('/principles', async request => {
    const { targetType, targetId, scope } = request.query;

    if (scope === 'coordinator') {
      const result = await proxyToCoordinator(
        'GET',
        `/principles?targetType=${targetType ?? ''}&targetId=${targetId ?? ''}`
      );
      return result ?? [];
    }

    return db.listPrinciples(targetType, targetId);
  });

  // Get a single principle
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/principles/:id',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyToCoordinator(
          'GET',
          `/principles/${request.params.id}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Principle not found' });
        }
        return result;
      }

      const row = db.getPrinciple(request.params.id);
      if (!row) {
        return reply.code(404).send({ error: 'Principle not found' });
      }
      return row;
    }
  );

  // Delete a principle
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/principles/:id',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyToCoordinator(
          'DELETE',
          `/principles/${request.params.id}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Principle not found' });
        }
        return result;
      }

      const deleted = db.deletePrinciple(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Principle not found' });
      }
      return { success: true };
    }
  );

  // === Wiki Routes ===

  // Helper to proxy wiki requests to coordinator
  const proxyWikiToCoordinator = async (
    method: string,
    path: string,
    body?: unknown
  ) => {
    const client = getCoordinatorClient();
    if (!client) {
      return null;
    }
    const url = `${client.getBaseUrl()}${path}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return res.json();
  };

  // List all wiki pages (beacon + coordinator)
  app.get('/wiki', async () => {
    const { listPages } = await import('./wiki-storage.js');
    const localPages = await listPages();
    const coordinatorPages = await proxyWikiToCoordinator('GET', '/wiki');
    if (coordinatorPages && Array.isArray(coordinatorPages)) {
      return [...localPages, ...coordinatorPages];
    }
    return localPages;
  });

  // Get a single wiki page (local or coordinator)
  app.get<{ Params: { pageId: string }; Querystring: { scope?: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyWikiToCoordinator(
          'GET',
          `/wiki/${request.params.pageId}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Wiki page not found' });
        }
        return result;
      }

      const { readPage } = await import('./wiki-storage.js');
      const page = await readPage(request.params.pageId);
      if (!page) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return page;
    }
  );

  // Create or update a wiki page (local or coordinator)
  app.put<{
    Params: { pageId: string };
    Body: {
      title: string;
      content: string;
      scope?: string;
      tags?: string[];
      sources?: string[];
    };
  }>('/wiki/:pageId', async (request, reply) => {
    const { pageId } = request.params;
    const { title, content, scope, tags, sources } = request.body;
    if (!title || !content) {
      return reply.code(400).send({ error: 'title and content are required' });
    }

    if (scope === 'coordinator') {
      const result = await proxyWikiToCoordinator(
        'PUT',
        `/wiki/${pageId}`,
        request.body
      );
      if (!result) {
        return reply
          .code(502)
          .send({ error: 'Failed to proxy to coordinator' });
      }
      return reply.code(200).send(result);
    }

    const { writePage } = await import('./wiki-storage.js');
    try {
      const page = await writePage(
        pageId,
        title,
        (scope as 'beacon' | 'coordinator') || 'beacon',
        content,
        tags ?? [],
        sources ?? []
      );
      return reply.code(200).send(page);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Delete a wiki page (local or coordinator)
  app.delete<{ Params: { pageId: string }; Querystring: { scope?: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyWikiToCoordinator(
          'DELETE',
          `/wiki/${request.params.pageId}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Wiki page not found' });
        }
        return result;
      }

      const { deletePage } = await import('./wiki-storage.js');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return { success: true };
    }
  );

  // Search wiki pages (beacon + coordinator)
  app.get<{ Querystring: { q: string } }>('/wiki/search', async request => {
    const { searchPages } = await import('./wiki-storage.js');
    const { q } = request.query;
    if (!q) return [];
    const localResults = await searchPages(q);
    const coordinatorResults = await proxyWikiToCoordinator(
      'GET',
      `/wiki/search?q=${encodeURIComponent(q)}`
    );
    if (coordinatorResults && Array.isArray(coordinatorResults)) {
      return [...localResults, ...coordinatorResults];
    }
    return localResults;
  });

  // Lint the local wiki
  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('./wiki-storage.js');
    return lintPages();
  });
}
