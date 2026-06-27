import type { FastifyInstance } from 'fastify';
import * as db from './db.js';
import type {
  CreatePersonaRequest,
  CreateSkillRequest,
  RegisterBeaconRequest,
  RegisterBeaconTrustRequest,
  CreateSessionRequest,
  EndSessionRequest,
  BeaconStatusResponse,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
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

  // === Beacon Routes (Legacy - for backwards compatibility) ===

  app.post<{ Body: RegisterBeaconRequest }>(
    '/beacons',
    async (request, reply) => {
      // If publicKey is provided, this is a trust registration
      if (request.body.publicKey) {
        const trustReq: RegisterBeaconTrustRequest = {
          id: request.body.id,
          name: request.body.name,
          host: request.body.host,
          port: request.body.port,
          publicKey: request.body.publicKey,
          tlsFingerprint: request.body.tlsFingerprint,
        };
        const trust = db.registerBeaconTrust(trustReq);
        
        // Return status response
        const response: BeaconStatusResponse = {
          status: trust.status,
        };
        if (trust.approvalToken) {
          response.approvalToken = trust.approvalToken;
        }
        return reply.code(201).send(response);
      }
      
      // Legacy: simple beacon registration
      const beacon = db.registerBeacon(request.body);
      return reply.code(201).send(beacon);
    }
  );

  app.get('/beacons', async () => {
    // Return both legacy beacons and trust entries
    const beacons = db.listBeacons();
    const trustList = db.listBeaconTrust();
    
    // Merge trust status into beacons
    const beaconsWithTrust = beacons.map(b => {
      const trust = trustList.find(t => t.beaconId === b.id);
      return {
        ...b,
        trustStatus: trust?.status ?? null,
        publicKey: trust?.publicKey ?? null,
      };
    });
    
    return beaconsWithTrust;
  });

  app.get<{ Params: { id: string } }>(
    '/beacons/:id',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      const trust = db.getBeaconTrust(request.params.id);
      
      if (!beacon && !trust) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      
      // Return merged beacon/trust info
      return {
        ...beacon,
        beaconId: beacon?.id ?? trust?.beaconId,
        name: beacon?.name ?? trust?.name,
        host: beacon?.host ?? trust?.host,
        port: beacon?.port ?? trust?.port,
        connectedAt: beacon?.connectedAt,
        lastHeartbeat: beacon?.lastHeartbeat,
        trustStatus: trust?.status ?? null,
        publicKey: trust?.publicKey ?? null,
        approvalToken: trust?.approvalToken ?? null,
      };
    }
  );

  // === Beacon Trust Routes (New) ===

  // Register a new beacon with trust
  app.post<{ Body: RegisterBeaconTrustRequest }>(
    '/beacons/trust',
    async (request, reply) => {
      const trust = db.registerBeaconTrust(request.body);
      
      // Return status response
      const response: BeaconStatusResponse = {
        status: trust.status,
      };
      if (trust.approvalToken) {
        response.approvalToken = trust.approvalToken;
      }
      return reply.code(201).send(response);
    }
  );

  // Get beacon trust status (for polling)
  app.get<{ Params: { id: string } }>(
    '/beacons/trust/:id',
    async (request, reply) => {
      const trust = db.getBeaconTrust(request.params.id);
      if (!trust) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      
      const response: BeaconStatusResponse = {
        status: trust.status,
      };
      // Only include approval token if pending
      if (trust.status === 'pending' && trust.approvalToken) {
        response.approvalToken = trust.approvalToken;
      }
      return response;
    }
  );

  // List all beacon trust entries
  app.get('/beacons/trust', async () => {
    return db.listBeaconTrust();
  });

  // Delete beacon trust
  app.delete<{ Params: { id: string } }>(
    '/beacons/trust/:id',
    async (request, reply) => {
      const deleted = db.deleteBeaconTrust(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      return { success: true };
    }
  );

  // === Approval Routes ===

  // Approve a pending beacon by token
  app.post<{ Body: { approvalToken: string } }>(
    '/beacons/approve',
    async (request, reply) => {
      const { approvalToken } = request.body;
      if (!approvalToken) {
        return reply.code(400).send({ error: 'approvalToken required' });
      }
      
      const trust = db.approveBeacon(approvalToken);
      if (!trust) {
        return reply.code(404).send({ error: 'Invalid or expired approval token' });
      }
      
      return { success: true, beacon: trust };
    }
  );

  // Reject a beacon
  app.post<{ Params: { id: string } }>(
    '/beacons/trust/:id/reject',
    async (request, reply) => {
      const success = db.rejectBeacon(request.params.id);
      if (!success) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
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

  // === Knowledge Routes ===

  // Create knowledge entry
  app.post<{ Body: CreateKnowledgeRequest }>('/knowledge', async (request, reply) => {
    const knowledge = db.createKnowledge(request.body);
    return reply.code(201).send(knowledge);
  });

  // List knowledge (with optional type filter)
  app.get<{ Querystring: { type?: string } }>('/knowledge', async (request) => {
    return db.listKnowledge(request.query.type);
  });

  // Get single knowledge entry
  app.get<{ Params: { id: string } }>('/knowledge/:id', async (request, reply) => {
    const knowledge = db.getKnowledge(request.params.id);
    if (!knowledge) {
      return reply.code(404).send({ error: 'Knowledge not found' });
    }
    return knowledge;
  });

  // Update knowledge entry
  app.put<{ Params: { id: string }; Body: UpdateKnowledgeRequest }>('/knowledge/:id', async (request, reply) => {
    const knowledge = db.updateKnowledge(request.params.id, request.body);
    if (!knowledge) {
      return reply.code(404).send({ error: 'Knowledge not found' });
    }
    return knowledge;
  });

  // Delete knowledge entry
  app.delete<{ Params: { id: string } }>('/knowledge/:id', async (request, reply) => {
    const deleted = db.deleteKnowledge(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: 'Knowledge not found' });
    }
    return { success: true };
  });

  // Search knowledge
  app.get<{ Querystring: { q?: string; type?: string } }>('/knowledge/search', async (request) => {
    const { q, type } = request.query;
    if (!q) {
      return db.listKnowledge(type);
    }
    return db.searchKnowledge(q, type);
  });

  // Upsert knowledge (sync endpoint - create or update by type+key)
  app.post<{ Body: CreateKnowledgeRequest }>('/sync/knowledge/push', async (request, reply) => {
    const knowledge = db.upsertKnowledge(request.body);
    return reply.code(200).send(knowledge);
  });

  // Pull knowledge (sync endpoint - get all knowledge, optionally since timestamp)
  app.get<{ Querystring: { since?: number; type?: string } }>('/sync/knowledge/pull', async (request) => {
    const { since, type } = request.query;
    let knowledge = db.listKnowledge(type);
    if (since) {
      knowledge = knowledge.filter(k => k.updatedAt > since);
    }
    return knowledge;
  });
}