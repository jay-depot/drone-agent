import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';
import {
  restSubscribeToChannel,
  restUnsubscribeFromChannel,
  isAgentConnected,
} from '../ws-server.js';

export default function channelRoutes(app: FastifyInstance) {
  // Subscribe an agent to a channel
  app.put<{
    Params: { agentId: string; channel: string };
  }>('/agents/:agentId/channels/:channel', async (request, reply) => {
    const { agentId, channel } = request.params;

    if (!isAgentConnected(agentId)) {
      // Allow REST subscriptions even for non-WS agents (they can retrieve
      // channel messages via the REST messages endpoint later).
    }

    restSubscribeToChannel(agentId, channel);

    return reply.code(200).send({
      agentId,
      channel,
      status: 'subscribed',
    });
  });

  // Unsubscribe an agent from a channel
  app.delete<{
    Params: { agentId: string; channel: string };
  }>('/agents/:agentId/channels/:channel', async (request, reply) => {
    const { agentId, channel } = request.params;

    restUnsubscribeFromChannel(agentId, channel);

    return reply.code(200).send({
      agentId,
      channel,
      status: 'unsubscribed',
    });
  });

  // Send a message to a channel
  app.post<{
    Params: { channel: string };
    Body: { fromAgentId: string; body: unknown };
  }>('/channels/:channel/messages', async (request, reply) => {
    const { channel } = request.params;
    const { fromAgentId, body } = request.body;

    if (!fromAgentId) {
      return reply.code(400).send({ error: 'fromAgentId is required' });
    }

    // Verify sender is registered
    const sender = db.getAgent(fromAgentId);
    if (!sender) {
      return reply
        .code(403)
        .send({ error: 'Sender agent not registered locally' });
    }

    const message = db.createMessage(
      fromAgentId,
      null,
      channel,
      typeof body === 'string' ? body : JSON.stringify(body)
    );

    return reply.code(201).send(message);
  });

  // Get messages for a channel
  app.get<{
    Params: { channel: string };
  }>('/channels/:channel/messages', async request => {
    const { channel } = request.params;
    return db.listMessagesByChannel(channel);
  });
}
