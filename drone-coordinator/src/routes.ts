import type { FastifyInstance } from 'fastify';
import * as db from './db.js';
import { isLargePayload, storeLargePayload } from './storage.js';
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
        const response: BeaconStatusResponse = { status: trust.status };
        if (trust.approvalToken) {
          response.approvalToken = trust.approvalToken;
        }
        return reply.code(201).send(response);
      }
      const beacon = db.registerBeacon(request.body);
      return reply.code(201).send(beacon);
    }
  );

  app.get('/beacons', async () => {
    const beacons = db.listBeacons();
    const trustList = db.listBeaconTrust();
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

  // === Beacon Trust Routes ===

  app.post<{ Body: RegisterBeaconTrustRequest }>(
    '/beacons/trust',
    async (request, reply) => {
      const trust = db.registerBeaconTrust(request.body);
      const response: BeaconStatusResponse = { status: trust.status };
      if (trust.approvalToken) {
        response.approvalToken = trust.approvalToken;
      }
      return reply.code(201).send(response);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/beacons/trust/:id',
    async (request, reply) => {
      const trust = db.getBeaconTrust(request.params.id);
      if (!trust) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      const response: BeaconStatusResponse = { status: trust.status };
      if (trust.status === 'pending' && trust.approvalToken) {
        response.approvalToken = trust.approvalToken;
      }
      return response;
    }
  );

  app.get('/beacons/trust', async () => {
    return db.listBeaconTrust();
  });

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

  app.post<{ Body: { approvalToken: string } }>(
    '/beacons/approve',
    async (request, reply) => {
      const { approvalToken } = request.body;
      if (!approvalToken) {
        return reply.code(400).send({ error: 'approvalToken required' });
      }
      const trust = db.approveBeacon(approvalToken);
      if (!trust) {
        return reply
          .code(404)
          .send({ error: 'Invalid or expired approval token' });
      }
      return { success: true, beacon: trust };
    }
  );

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

  app.post<{ Body: CreateKnowledgeRequest }>(
    '/knowledge',
    async (request, reply) => {
      const knowledge = db.createKnowledge(request.body);
      return reply.code(201).send(knowledge);
    }
  );

  app.get<{ Querystring: { type?: string } }>('/knowledge', async request => {
    return db.listKnowledge(request.query.type);
  });

  app.get<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const knowledge = db.getKnowledge(request.params.id);
      if (!knowledge) {
        return reply.code(404).send({ error: 'Knowledge not found' });
      }
      return knowledge;
    }
  );

  app.put<{ Params: { id: string }; Body: UpdateKnowledgeRequest }>(
    '/knowledge/:id',
    async (request, reply) => {
      const knowledge = db.updateKnowledge(request.params.id, request.body);
      if (!knowledge) {
        return reply.code(404).send({ error: 'Knowledge not found' });
      }
      return knowledge;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/knowledge/:id',
    async (request, reply) => {
      const deleted = db.deleteKnowledge(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Knowledge not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { q?: string; type?: string } }>(
    '/knowledge/search',
    async request => {
      const { q, type } = request.query;
      if (!q) {
        return db.listKnowledge(type);
      }
      return db.searchKnowledge(q, type);
    }
  );

  app.post<{ Body: CreateKnowledgeRequest }>(
    '/sync/knowledge/push',
    async (request, reply) => {
      const knowledge = db.upsertKnowledge(request.body);
      return reply.code(200).send(knowledge);
    }
  );

  app.get<{ Querystring: { since?: number; type?: string } }>(
    '/sync/knowledge/pull',
    async request => {
      const { since, type } = request.query;
      let knowledge = db.listKnowledge(type);
      if (since) {
        knowledge = knowledge.filter(k => k.updatedAt > since);
      }
      return knowledge;
    }
  );

  // === Insight Routes ===

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
    const row = db.createInsight(targetType, targetId, insight, scope);
    return reply.code(201).send(row);
  });

  app.get<{ Querystring: { targetType?: string; targetId?: string } }>(
    '/insights',
    async request => {
      return db.listInsights(request.query.targetType, request.query.targetId);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/insights/:id',
    async (request, reply) => {
      const row = db.getInsight(request.params.id);
      if (!row) {
        return reply.code(404).send({ error: 'Insight not found' });
      }
      return row;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/insights/:id',
    async (request, reply) => {
      const deleted = db.deleteInsight(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Insight not found' });
      }
      return { success: true };
    }
  );

  // === Principle Routes ===

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
    const row = db.createPrinciple(
      targetType,
      targetId,
      principle,
      source,
      scope
    );
    return reply.code(201).send(row);
  });

  app.get<{ Querystring: { targetType?: string; targetId?: string } }>(
    '/principles',
    async request => {
      return db.listPrinciples(
        request.query.targetType,
        request.query.targetId
      );
    }
  );

  app.get<{ Params: { id: string } }>(
    '/principles/:id',
    async (request, reply) => {
      const row = db.getPrinciple(request.params.id);
      if (!row) {
        return reply.code(404).send({ error: 'Principle not found' });
      }
      return row;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/principles/:id',
    async (request, reply) => {
      const deleted = db.deletePrinciple(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Principle not found' });
      }
      return { success: true };
    }
  );

  // === Wiki Routes ===

  app.get('/wiki', async () => {
    const { listPages } = await import('./wiki-storage.js');
    return listPages();
  });

  app.get<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { readPage } = await import('./wiki-storage.js');
      const page = await readPage(request.params.pageId);
      if (!page) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return page;
    }
  );

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
    const { writePage } = await import('./wiki-storage.js');
    const { pageId } = request.params;
    const { title, content, scope, tags, sources } = request.body;
    if (!title || !content) {
      return reply.code(400).send({ error: 'title and content are required' });
    }
    try {
      const page = await writePage(
        pageId,
        title,
        (scope as 'beacon' | 'coordinator') || 'coordinator',
        content,
        tags ?? [],
        sources ?? []
      );
      return reply.code(200).send(page);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { deletePage } = await import('./wiki-storage.js');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { q: string } }>('/wiki/search', async request => {
    const { searchPages } = await import('./wiki-storage.js');
    const { q } = request.query;
    if (!q) return [];
    return searchPages(q);
  });

  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('./wiki-storage.js');
    return lintPages();
  });

  // === Swarm Session Routes ===

  app.post<{ Body: { id: string; personaId?: string; beaconId: string } }>(
    '/sync/sessions/register',
    async (request, reply) => {
      const { id, personaId, beaconId } = request.body;
      if (!id || !beaconId) {
        return reply.code(400).send({ error: 'id and beaconId are required' });
      }
      const session = db.createSwarmSession(id, personaId ?? null, beaconId);
      return reply.code(201).send(session);
    }
  );

  app.post<{
    Body: {
      events: Array<{
        id: string;
        sessionId: string;
        correlationId?: string;
        type: string;
        payload?: string;
        metadata?: string;
        createdAt: number;
      }>;
    };
  }>('/sync/events/push', async (request, reply) => {
    const { events } = request.body;
    if (!events || !Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({ error: 'events array is required' });
    }
    const created: db.SwarmEvent[] = [];
    for (const evt of events) {
      let payload = evt.payload ?? null;
      let metadata = evt.metadata ?? null;
      if (payload && isLargePayload(payload)) {
        const ref = storeLargePayload(evt.sessionId, evt.id, payload);
        payload = ref;
      }
      const event = db.createSwarmEvent({
        id: evt.id,
        sessionId: evt.sessionId,
        correlationId: evt.correlationId ?? null,
        type: evt.type,
        payload,
        metadata,
        createdAt: evt.createdAt,
      });
      created.push(event);
    }
    return reply.code(201).send({ count: created.length, events: created });
  });

  app.get<{
    Params: { id: string };
    Querystring: { correlationId?: string; limit?: number; offset?: number };
  }>('/sessions/:id/events', async (request, reply) => {
    const session = db.getSwarmSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return db.getSwarmEvents(request.params.id, {
      correlationId: request.query.correlationId,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/sessions/:id/events/latest',
    async (request, reply) => {
      const session = db.getSwarmSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const limit = request.query.limit ? Number(request.query.limit) : 10;
      return db.getLatestSwarmEvents(request.params.id, limit);
    }
  );

  app.get<{ Querystring: { q: string } }>(
    '/events/search',
    async (request, reply) => {
      const { q } = request.query;
      if (!q) {
        return reply.code(400).send({ error: 'q query parameter is required' });
      }
      return db.searchSwarmEvents(q);
    }
  );

  // === Agent Location Routes ===

  app.post<{ Body: { agentId: string; beaconId: string; personaId?: string } }>(
    '/agents/location',
    async (request, reply) => {
      const { agentId, beaconId, personaId } = request.body;
      if (!agentId || !beaconId) {
        return reply
          .code(400)
          .send({ error: 'agentId and beaconId are required' });
      }
      const location = db.registerAgentLocation(
        agentId,
        beaconId,
        personaId ?? null
      );
      return reply.code(201).send(location);
    }
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/location/:agentId',
    async (request, reply) => {
      const location = db.getAgentLocation(request.params.agentId);
      if (!location) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      const beacon = db.getBeacon(location.beaconId);
      return {
        ...location,
        beaconHost: beacon?.host,
        beaconPort: beacon?.port,
      };
    }
  );

  app.post<{ Params: { agentId: string } }>(
    '/agents/location/:agentId/heartbeat',
    async (request, reply) => {
      const location = db.updateAgentLocationHeartbeat(request.params.agentId);
      if (!location) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      return { success: true };
    }
  );

  app.delete<{ Params: { agentId: string } }>(
    '/agents/location/:agentId',
    async (request, reply) => {
      const deleted = db.unregisterAgentLocation(request.params.agentId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { beaconId?: string } }>(
    '/agents/location',
    async request => {
      const { beaconId } = request.query;
      if (beaconId) {
        return db.listAgentLocationsByBeacon(beaconId);
      }
      return db.listAllAgentLocations();
    }
  );

  // === Message Relay Routes ===

  app.post<{
    Body: {
      fromBeaconId: string;
      fromAgentId: string;
      toAgentId: string;
      body: string;
    };
  }>('/messages/relay', async (request, reply) => {
    const { fromBeaconId, fromAgentId, toAgentId, body } = request.body;
    if (!fromBeaconId || !fromAgentId || !toAgentId || !body) {
      return reply
        .code(400)
        .send({
          error: 'fromBeaconId, fromAgentId, toAgentId, and body are required',
        });
    }
    const location = db.getAgentLocation(toAgentId);
    if (!location) {
      return reply
        .code(404)
        .send({ error: 'Target agent not found', code: 'AGENT_NOT_FOUND' });
    }
    const beacon = db.getBeacon(location.beaconId);
    if (!beacon) {
      return reply
        .code(503)
        .send({ error: 'Target beacon not found', code: 'BEACON_NOT_FOUND' });
    }
    try {
      const targetUrl = `http://${beacon.host}:${beacon.port}`;
      const response = await fetch(`${targetUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAgentId, fromBeaconId, toAgentId, body }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        return reply
          .code(502)
          .send({
            error: 'Failed to deliver message to target beacon',
            details: errorText,
          });
      }
      const messageData = (await response.json()) as { id: string };
      return { success: true, messageId: messageData.id, delivered: true };
    } catch (err) {
      return reply.code(503).send({
        error: 'Target beacon unavailable',
        details: err instanceof Error ? err.message : 'Unknown error',
        code: 'BEACON_UNAVAILABLE',
      });
    }
  });

  app.post<{ Body: { fromAgentId: string; channel: string; body: string } }>(
    '/messages/broadcast',
    async (request, reply) => {
      const { fromAgentId, channel, body } = request.body;
      if (!fromAgentId || !channel || !body) {
        return reply
          .code(400)
          .send({ error: 'fromAgentId, channel, and body are required' });
      }
      const beacons = db.listBeacons();
      let deliveredCount = 0;
      for (const beacon of beacons) {
        try {
          const targetUrl = `http://${beacon.host}:${beacon.port}`;
          const response = await fetch(`${targetUrl}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromAgentId, toChannel: channel, body }),
          });
          if (response.ok) deliveredCount++;
        } catch {
          /* skip unreachable beacons */
        }
      }
      return { success: true, deliveredCount, totalBeacons: beacons.length };
    }
  );
}
