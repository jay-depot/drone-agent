import type { FastifyInstance } from 'fastify';
import { proxyToCoordinator } from './context.js';
import * as db from '../db.js';

export default function insightRoutes(app: FastifyInstance) {
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
}