import type { FastifyInstance } from 'fastify';
import type { CreateMessageRequest } from '../types.js';
import { handleDeliverMessage } from './message-handlers.js';
import * as db from '../db/index.js';

export default function messageRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateMessageRequest }>(
    '/messages',
    async (request, reply) => {
      const { status, body } = handleDeliverMessage(request.body);
      return reply.code(status).send(body);
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
    async request => {
      return db.listMessagesByChannel(request.params.channel);
    }
  );
}
