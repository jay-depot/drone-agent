import type { FastifyInstance } from 'fastify';
import { type EventQuery } from './context.js';
import * as db from '../db.js';

export default function eventRoutes(app: FastifyInstance) {
  // List event logs with optional filters
  app.get<{ Querystring: EventQuery }>('/events', async (request, _reply) => {
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
}
