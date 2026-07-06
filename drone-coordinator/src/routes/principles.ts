import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';

export default function principleRoutes(app: FastifyInstance) {
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
}
