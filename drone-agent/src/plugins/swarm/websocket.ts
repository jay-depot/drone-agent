/**
 * WebSocket client for the swarm plugin.
 *
 * Manages the WebSocket connection to the beacon for real-time
 * inter-agent messaging.
 */

import type { SwarmContext } from './context.js';

/**
 * Connect to the beacon WebSocket and set up event handlers.
 */
export function connectWebSocket(ctx: SwarmContext): void {
  const { registration, wsUrl } = ctx;
  try {
    ctx.ws = new WebSocket(wsUrl);

    ctx.ws.onopen = () => {
      registration.logger.info('WebSocket connected to beacon');
      ctx.wsReconnectAttempts = 0;
      while (ctx.messageQueue.length > 0) {
        const msg = ctx.messageQueue.shift();
        if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
          ctx.ws.send(JSON.stringify({ type: 'message', payload: msg }));
        }
      }
    };

    ctx.ws.onmessage = event => {
      try {
        const wsMsg = JSON.parse(event.data);
        if (wsMsg.type === 'message') {
          ctx.pendingMessages.push(wsMsg.payload);
          registration.logger.info(
            `Received message from ${wsMsg.payload.fromAgentId}`
          );
        } else if (wsMsg.type === 'connected') {
          registration.logger.info('WebSocket handshake complete');
        } else if (wsMsg.type === 'ack') {
          registration.logger.info(
            `Message ${wsMsg.payload.messageId} acknowledged`
          );
        } else if (wsMsg.type === 'error') {
          registration.logger.error(
            `WebSocket error: ${wsMsg.payload.message}`
          );
        }
      } catch (err) {
        registration.logger.error(`Failed to parse WebSocket message: ${err}`);
      }
    };

    ctx.ws.onclose = event => {
      registration.logger.warn(
        `WebSocket closed: ${event.code} ${event.reason}`
      );
      ctx.ws = null;
      if (ctx.shuttingDown) {
        registration.logger.info(
          'WebSocket closed during shutdown; skipping reconnect'
        );
        return;
      }
      if (ctx.wsReconnectAttempts < ctx.maxReconnectAttempts) {
        ctx.wsReconnectAttempts++;
        const delay = Math.min(
          1000 * Math.pow(2, ctx.wsReconnectAttempts),
          30000
        );
        setTimeout(() => connectWebSocket(ctx), delay);
      }
    };

    ctx.ws.onerror = error => {
      const message = (error as ErrorEvent).message || String(error);
      registration.logger.error(`WebSocket error: ${message}`);
    };
  } catch (err) {
    registration.logger.error(`Failed to connect WebSocket: ${err}`);
  }
}

/**
 * Send a message to another agent or channel via WebSocket.
 */
export function sendMessage(
  ctx: SwarmContext,
  toAgentId: string | undefined,
  toChannel: string | undefined,
  body: string
): void {
  const payload = { toAgentId, toChannel, body };
  if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify({ type: 'message', payload }));
  } else {
    ctx.messageQueue.push(payload);
  }
}

/**
 * Subscribe to a channel.
 */
export function subscribeToChannel(ctx: SwarmContext, channel: string): void {
  if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify({ type: 'subscribe', payload: { channel } }));
  }
}

/**
 * Unsubscribe from a channel.
 */
export function unsubscribeFromChannel(
  ctx: SwarmContext,
  channel: string
): void {
  if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify({ type: 'unsubscribe', payload: { channel } }));
  }
}

/**
 * Get and clear pending messages.
 */
export function getPendingMessages(ctx: SwarmContext) {
  const messages = [...ctx.pendingMessages];
  ctx.pendingMessages.length = 0;
  return messages;
}
