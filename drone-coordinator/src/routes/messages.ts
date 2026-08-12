import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';
import { sendBeaconCommand } from '../beacon-ws.js';

export default function messageRoutes(app: FastifyInstance) {
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
      return reply.code(400).send({
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
      const res = await sendBeaconCommand(
        location.beaconId,
        'deliverMessage',
        { fromAgentId, fromBeaconId, toAgentId, body }
      );
      if (!res.ok) {
        return reply.code(502).send({
          error: 'Failed to deliver message to target beacon',
          details:
            res.body && typeof res.body === 'object' && 'error' in res.body
              ? (res.body as { error: string }).error
              : 'Unknown beacon error',
        });
      }
      const messageData = res.body as { id?: string };
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
          const res = await sendBeaconCommand(
            beacon.id,
            'deliverMessage',
            { fromAgentId, toChannel: channel, body }
          );
          if (res.ok) deliveredCount++;
        } catch {
          /* skip unreachable beacons */
        }
      }
      return { success: true, deliveredCount, totalBeacons: beacons.length };
    }
  );
}
