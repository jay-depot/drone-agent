import type { FastifyInstance } from 'fastify';
import { proxyToCoordinator } from './context.js';
import * as db from '../db/index.js';

export default function principleRoutes(app: FastifyInstance) {
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
}
