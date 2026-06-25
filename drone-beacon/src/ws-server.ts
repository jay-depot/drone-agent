import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import * as db from "./db.js";
import { logger } from "./logger.js";

interface WSConnection {
  socket: WebSocket;
  agentId: string;
}

// Map of agentId -> connection
const connections = new Map<string, WSConnection>();

// Channel subscriptions: channel -> Set<agentId>
const channelSubscriptions = new Map<string, Set<string>>();

export function getConnection(agentId: string): WSConnection | undefined {
  return connections.get(agentId);
}

export function getConnectedAgents(): string[] {
  return Array.from(connections.keys());
}

export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}

function subscribeToChannel(agentId: string, channel: string): void {
  let subs = channelSubscriptions.get(channel);
  if (!subs) {
    subs = new Set();
    channelSubscriptions.set(channel, subs);
  }
  subs.add(agentId);
  logger.info(`Agent ${agentId} subscribed to channel ${channel}`);
}

function unsubscribeFromChannel(agentId: string, channel: string): void {
  const subs = channelSubscriptions.get(channel);
  if (subs) {
    subs.delete(agentId);
    if (subs.size === 0) {
      channelSubscriptions.delete(channel);
    }
  }
}

export function sendToAgent(agentId: string, message: object): boolean {
  const conn = connections.get(agentId);
  if (conn && conn.socket.readyState === "OPEN") {
    conn.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

export function sendToChannel(channel: string, message: object): number {
  const subs = channelSubscriptions.get(channel);
  if (!subs) return 0;

  let count = 0;
  for (const agentId of subs) {
    if (sendToAgent(agentId, message)) {
      count++;
    }
  }
  return count;
}

interface WSMessage {
  type: "message" | "ack" | "ping" | "pong" | "subscribe" | "unsubscribe";
  payload: unknown;
}

interface MessagePayload {
  toAgentId?: string;
  toChannel?: string;
  body: string;
}

interface AckPayload {
  messageId: string;
}

interface ChannelPayload {
  channel: string;
}

function handleMessage(agentId: string, wsMsg: WSMessage): void {
  switch (wsMsg.type) {
    case "message": {
      const payload = wsMsg.payload as MessagePayload;
      const { toAgentId, toChannel, body } = payload;

      if (!toAgentId && !toChannel) {
        sendToAgent(agentId, {
          type: "error",
          payload: { message: "Must specify toAgentId or toChannel" },
        });
        return;
      }

      // Create message in database
      const message = db.createMessage(agentId, toAgentId ?? null, toChannel ?? null, body);
      logger.info(`Message ${message.id} from ${agentId} to ${toAgentId ?? toChannel}`);

      // Deliver to recipient(s)
      if (toAgentId) {
        // Direct message
        if (connections.has(toAgentId)) {
          // Recipient connected - push immediately
          sendToAgent(toAgentId, {
            type: "message",
            payload: {
              id: message.id,
              fromAgentId: agentId,
              channel: null,
              body: JSON.parse(body),
              receivedAt: Date.now(),
            },
          });
          // Mark as delivered
          db.markMessageDelivered(message.id);
        }
        // If not connected, message stays in DB as unread
      } else if (toChannel) {
        // Channel broadcast
        const count = sendToChannel(toChannel, {
          type: "message",
          payload: {
            id: message.id,
            fromAgentId: agentId,
            channel: toChannel,
            body: JSON.parse(body),
            receivedAt: Date.now(),
          },
        });
        logger.info(`Broadcast to ${count} subscribers on channel ${toChannel}`);
        // Mark as delivered for all (for cleanup purposes)
        db.markMessageDelivered(message.id);
      }

      // Confirm to sender
      sendToAgent(agentId, {
        type: "ack",
        payload: { messageId: message.id, status: "sent" },
      });
      break;
    }

    case "ack": {
      const payload = wsMsg.payload as AckPayload;
      db.markMessageDelivered(payload.messageId);
      logger.debug(`Message ${payload.messageId} acknowledged by ${agentId}`);
      break;
    }

    case "ping": {
      sendToAgent(agentId, { type: "pong" });
      break;
    }

    case "pong": {
      // Keepalive acknowledged
      break;
    }

    case "subscribe": {
      const payload = wsMsg.payload as ChannelPayload;
      subscribeToChannel(agentId, payload.channel);
      sendToAgent(agentId, {
        type: "ack",
        payload: { messageId: "subscribe", status: "subscribed", channel: payload.channel },
      });
      break;
    }

    case "unsubscribe": {
      const payload = wsMsg.payload as ChannelPayload;
      unsubscribeFromChannel(agentId, payload.channel);
      sendToAgent(agentId, {
        type: "ack",
        payload: { messageId: "unsubscribe", status: "unsubscribed", channel: payload.channel },
      });
      break;
    }

    default:
      logger.warn(`Unknown WS message type: ${(wsMsg as WSMessage).type}`);
  }
}

export async function registerWebSocketServer(app: FastifyInstance): Promise<void> {
  // Register WebSocket plugin
  await app.register(import("@fastify/websocket"), {
    options: {
      maxPayload: 1024 * 1024, // 1MB max message size
    },
  });

  // WebSocket upgrade handler
  app.get("/ws", { websocket: true }, (socket, request) => {
    const agentId = (request.query as Record<string, string>).agentId;

    if (!agentId) {
      socket.close(4001, "Missing agentId query parameter");
      return;
    }

    // Verify agent is registered
    const agent = db.getAgent(agentId);
    if (!agent) {
      socket.close(4002, "Agent not registered");
      return;
    }

    // Store connection
    connections.set(agentId, { socket, agentId });
    logger.info(`Agent ${agentId} connected via WebSocket`);

    // Deliver any unread messages on connect
    const unreadMessages = db.listMessagesForAgent(agentId, true);
    for (const msg of unreadMessages) {
      sendToAgent(agentId, {
        type: "message",
        payload: {
          id: msg.id,
          fromAgentId: msg.fromAgentId,
          channel: msg.channel,
          body: JSON.parse(msg.body),
          receivedAt: msg.createdAt,
        },
      });
    }
    if (unreadMessages.length > 0) {
      logger.info(`Delivered ${unreadMessages.length} unread messages to ${agentId}`);
    }

    // Handle incoming messages
    socket.on("message", (data: Buffer) => {
      try {
        const wsMsg = JSON.parse(data.toString()) as WSMessage;
        handleMessage(agentId, wsMsg);
      } catch (err) {
        logger.error(err, "Failed to parse WebSocket message");
        socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid message format" } }));
      }
    });

    // Handle disconnect
    socket.on("close", () => {
      connections.delete(agentId);
      logger.info(`Agent ${agentId} disconnected from WebSocket`);

      // Unsubscribe from all channels
      for (const subs of channelSubscriptions.values()) {
        subs.delete(agentId);
      }
    });

    // Send welcome message
    socket.send(JSON.stringify({ type: "connected", payload: { agentId } }));
  });

  logger.info("WebSocket server registered at /ws");
}

// Cleanup old messages periodically
let cleanupInterval: NodeJS.Timeout | null = null;

export function startMessageCleanup(intervalHours: number = 24): void {
  // Run cleanup every hour
  cleanupInterval = setInterval(() => {
    const deleted = db.cleanupOldMessages(24);
    if (deleted > 0) {
      logger.info(`Message cleanup: removed ${deleted} old messages`);
    }
  }, 60 * 60 * 1000);
  logger.info(`Message cleanup scheduled every hour (retention: 24h)`);
}

export function stopMessageCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info("Message cleanup stopped");
  }
}