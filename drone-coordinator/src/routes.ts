import type { FastifyInstance } from 'fastify';
import * as db from './db.js';
import type {
  CreatePersonaRequest,
  CreateSkillRequest,
  RegisterBeaconRequest,
  CreateSessionRequest,
  EndSessionRequest,
} from './types.js';

export async function registerRoutes(app: FastifyInstance) {
  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // === Persona Routes ===

  app.post<{ Body: CreatePersonaRequest }>(
    '/personas',
    async (request, reply) => {
      const persona = db.createPersona(request.body);
      return reply.code(201).send(persona);
    }
  );

  app.get('/personas', async () => {
    return db.listPersonas();
  });

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

  app.put<{ Params: { id: string }; Body: Partial<CreatePersonaRequest> }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.updatePersona(request.params.id, request.body);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return persona;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const deleted = db.deletePersona(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return { success: true };
    }
  );

  // === Skill Routes ===

  app.post<{ Body: CreateSkillRequest }>('/skills', async (request, reply) => {
    const skill = db.createSkill(request.body);
    return reply.code(201).send(skill);
  });

  app.get('/skills', async () => {
    return db.listSkills();
  });

  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const skill = db.getSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    return skill;
  });

  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>(
    '/skills/:id',
    async (request, reply) => {
      const skill = db.updateSkill(request.params.id, request.body);
      if (!skill) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      return skill;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/skills/:id',
    async (request, reply) => {
      const deleted = db.deleteSkill(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      return { success: true };
    }
  );

  // === Beacon Routes ===

  app.post<{ Body: RegisterBeaconRequest }>(
    '/beacons',
    async (request, reply) => {
      const beacon = db.registerBeacon(request.body);
      return reply.code(201).send(beacon);
    }
  );

  app.get('/beacons', async () => {
    return db.listBeacons();
  });

  app.get<{ Params: { id: string } }>(
    '/beacons/:id',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return beacon;
    }
  );

  app.post<{ Params: { id: string } }>(
    '/beacons/:id/heartbeat',
    async (request, reply) => {
      const beacon = db.heartbeatBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return beacon;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/beacons/:id',
    async (request, reply) => {
      const deleted = db.deleteBeacon(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return { success: true };
    }
  );

  // === Beacon Session Routes ===

  // Register a new agent session
  app.post<{ Params: { id: string }; Body: CreateSessionRequest }>(
    '/beacons/:id/sessions',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      const session = db.createBeaconSession(request.params.id, request.body);
      return reply.code(201).send(session);
    }
  );

  // List all sessions for a beacon
  app.get<{ Params: { id: string } }>(
    '/beacons/:id/sessions',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return db.listBeaconSessions(request.params.id);
    }
  );

  // Get specific session for a beacon
  app.get<{ Params: { id: string; agentId: string } }>(
    '/beacons/:id/sessions/:agentId',
    async (request, reply) => {
      const session = db.getBeaconSession(
        request.params.id,
        request.params.agentId
      );
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return session;
    }
  );

  // End a session (mark as disconnected)
  app.delete<{
    Params: { id: string; agentId: string };
    Body: EndSessionRequest;
  }>('/beacons/:id/sessions/:agentId', async (request, reply) => {
    const { disconnectedAt, durationMs } = request.body;
    const session = db.endBeaconSession(
      request.params.id,
      request.params.agentId,
      disconnectedAt,
      durationMs
    );
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return session;
  });
}
