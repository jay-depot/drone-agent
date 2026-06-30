import { type WebSocket } from '@fastify/websocket';
import { logger } from './logger.js';

/**
 * In-memory pub/sub for pushing swarm events to connected WebSocket clients.
 * Supports both global subscriptions (all events) and per-session subscriptions.
 */

type Subscriber = {
  ws: WebSocket;
  sessionIds: Set<string>; // empty set = subscribe to all
};

const subscribers = new Set<Subscriber>();

export function addSubscriber(ws: WebSocket): Subscriber {
  const sub: Subscriber = { ws, sessionIds: new Set() };
  subscribers.add(sub);
  return sub;
}

export function removeSubscriber(sub: Subscriber): void {
  subscribers.delete(sub);
}

export function subscribeToSession(sub: Subscriber, sessionId: string): void {
  sub.sessionIds.add(sessionId);
}

export function unsubscribeFromSession(
  sub: Subscriber,
  sessionId: string
): void {
  sub.sessionIds.delete(sessionId);
}

export function publishEvent(event: {
  sessionId: string;
  eventType: string;
  payload?: unknown;
}): void {
  const message = JSON.stringify({
    type: 'event',
    sessionId: event.sessionId,
    eventType: event.eventType,
    payload: event.payload,
  });
  for (const sub of subscribers) {
    try {
      // If subscriber has no session filters, send all events
      // Otherwise, only send if they're subscribed to this session
      if (sub.sessionIds.size === 0 || sub.sessionIds.has(event.sessionId)) {
        sub.ws.send(message);
      }
    } catch (err) {
      logger.warn(`Failed to send WS message: ${err}`);
      subscribers.delete(sub);
    }
  }
}

export function publishInitialState(
  ws: WebSocket,
  data: Record<string, unknown>
): void {
  try {
    ws.send(JSON.stringify({ type: 'initial', data }));
  } catch (err) {
    logger.warn(`Failed to send initial state: ${err}`);
  }
}

export function getSubscriberCount(): number {
  return subscribers.size;
}
