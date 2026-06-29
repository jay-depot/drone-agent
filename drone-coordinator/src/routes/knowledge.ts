import type { FastifyInstance } from 'fastify';
import type { CreateKnowledgeRequest, UpdateKnowledgeRequest } from '../types.js';
import * as db from '../db.js';

export default function knowledgeRoutes(app: FastifyInstance) {
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
}