import type { FastifyInstance } from 'fastify';
import type { CreateMessageRequest } from '../types.js';
import * as db from '../db/index.js';
import * as wsServer from '../ws-server.js';

export default function messageRoutes(app: FastifyInstance) {
  // Send a message (REST fallback for non-WS clients)
  // Updated to support cross-beacon messages via coordinator relay
  app.post<{ Body: CreateMessageRequest }>(
    '/messages',
    async (request, reply) => {
      const { fromAgentId, fromBeaconId, toAgentId, toChannel, body } =
        request.body;

      // Validate sender - either local agent or cross-beacon relay
      if (!fromAgentId) {
        return reply.code(400).send({ error: 'fromAgentId is required' });
      }

      // If fromBeaconId is present, this is a cross-beacon message
      // We don't require the sender to be a local agent
      const isLocalSender = !fromBeaconId;
      if (isLocalSender) {
        // Verify sender is registered locally
        const sender = db.getAgent(fromAgentId);
        if (!sender) {
          return reply
            .code(403)
            .send({ error: 'Sender agent not registered locally' });
        }
      }

      if (!toAgentId && !toChannel) {
        return reply
          .code(400)
          .send({ error: 'Must specify toAgentId or toChannel' });
      }

      const message = db.createMessage(
        fromAgentId,
        toAgentId ?? null,
        toChannel ?? null,
        body
      );

      // Try to deliver immediately if recipient is connected
      if (toAgentId && wsServer.isAgentConnected(toAgentId)) {
        wsServer.sendToAgent(toAgentId, {
          type: 'message',
          payload: {
            id: message.id,
            fromAgentId,
            fromBeaconId: fromBeaconId ?? null,
            body: JSON.parse(body),
            receivedAt: message.createdAt,
          },
        });
        db.markMessageDelivered(message.id);
      }

      return reply.code(201).send(message);
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
    async (request, reply) => {
      return db.listMessagesByChannel(request.params.channel);
    }
  );
}
