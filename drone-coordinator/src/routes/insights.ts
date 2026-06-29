import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';

export default function insightRoutes(app: FastifyInstance) {
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
}