import type { CreateMessageRequest } from '../types.js';
import * as db from '../db/index.js';
import * as wsServer from '../ws-server.js';

/**
 * Deliver a message to an agent or channel. Shared by the REST route and the
 * reverse-channel command handler so both paths behave identically.
 */
export function handleDeliverMessage(
  req: CreateMessageRequest
): { status: number; body: unknown } {
  const { fromAgentId, fromBeaconId, toAgentId, toChannel, body } = req;

  if (!fromAgentId) {
    return { status: 400, body: { error: 'fromAgentId is required' } };
  }

  // If fromBeaconId is present, this is a cross-beacon message relayed by the
  // coordinator — the sender is not required to be a local agent.
  const isLocalSender = !fromBeaconId;
  if (isLocalSender) {
    const sender = db.getAgent(fromAgentId);
    if (!sender) {
      return { status: 403, body: { error: 'Sender agent not registered locally' } };
    }
  }

  if (!toAgentId && !toChannel) {
    return { status: 400, body: { error: 'Must specify toAgentId or toChannel' } };
  }

  const message = db.createMessage(
    fromAgentId,
    toAgentId ?? null,
    toChannel ?? null,
    body
  );

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

  return { status: 201, body: message };
}
