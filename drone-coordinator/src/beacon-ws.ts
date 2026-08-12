import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import {
  getClientCertFingerprint,
  resolveBeaconIdByFingerprint,
} from './mtls.js';
import { logger } from './logger.js';

/**
 * Reverse-channel WebSocket registry on the coordinator side.
 *
 * Beacons open an outbound WebSocket to the coordinator's `/ws/beacon`
 * endpoint, authenticating via their mTLS client certificate. The coordinator
 * resolves the beaconId from the certificate fingerprint and stores the
 * socket so it can push spawn/message commands down the channel — eliminating
 * the need for the coordinator to make inbound HTTP calls to the beacon.
 */

interface BeaconConnection {
  ws: WebSocket;
  beaconId: string;
}

const connections = new Map<string, BeaconConnection>();

// Pending command requests awaiting a response: id -> resolver
const pendingRequests = new Map<string, (res: CommandResponse) => void>();

export interface CommandResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

interface IncomingMessage {
  type: 'response';
  id: string;
  ok: boolean;
  status?: number;
  body?: unknown;
}

/**
 * Register the `/ws/beacon` endpoint on the coordinator's primary app.
 * The WebSocket plugin must already be registered on `app`.
 */
export function registerBeaconWebSocket(app: FastifyInstance): void {
  app.get('/ws/beacon', { websocket: true }, (socket, request) => {
    const fingerprint = getClientCertFingerprint(request as any);
    const beaconId = fingerprint
      ? resolveBeaconIdByFingerprint(fingerprint)
      : undefined;

    if (!beaconId) {
      logger.warn(
        'Rejected beacon WebSocket connection: client certificate not a registered beacon'
      );
      socket.close(
        4001,
        'Unauthorized: client certificate not a registered beacon'
      );
      return;
    }

    const conn: BeaconConnection = { ws: socket, beaconId };
    connections.set(beaconId, conn);
    logger.info(`Beacon ${beaconId} connected via reverse-channel WebSocket`);

    socket.on('message', (raw: Buffer) => {
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'response' || !msg.id) {
        return;
      }
      const resolver = pendingRequests.get(msg.id);
      if (resolver) {
        pendingRequests.delete(msg.id);
        resolver({
          ok: msg.ok,
          status: msg.status,
          body: msg.body,
        });
      }
    });

    socket.on('close', () => {
      connections.delete(beaconId);
      logger.info(
        `Beacon ${beaconId} disconnected from reverse-channel WebSocket`
      );
    });
  });
}

/**
 * Send a command to a beacon over its reverse-channel WebSocket and resolve
 * with the beacon's response. Rejects when the beacon is not connected or the
 * response does not arrive within `timeoutMs`.
 */
export function sendBeaconCommand(
  beaconId: string,
  command: string,
  payload?: unknown,
  timeoutMs = 15000
): Promise<CommandResponse> {
  const conn = connections.get(beaconId);
  if (!conn) {
    return Promise.reject(
      new Error('Beacon not connected via reverse channel')
    );
  }

  const id = randomUUID();
  const message = JSON.stringify({ type: 'command', id, command, payload });

  return new Promise<CommandResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Timed out waiting for beacon response'));
    }, timeoutMs);

    pendingRequests.set(id, res => {
      clearTimeout(timer);
      resolve(res);
    });

    conn.ws.send(message, (err?: Error) => {
      if (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(err);
      }
    });
  });
}

/** True when a beacon has an open reverse-channel connection. */
export function isBeaconConnected(beaconId: string): boolean {
  return connections.has(beaconId);
}

/**
 * Test-only helper: register a connection with a fake WebSocket so
 * `sendBeaconCommand` can be exercised without a live server.
 */
export function _registerTestConnection(
  beaconId: string,
  fakeWs: WebSocket
): void {
  connections.set(beaconId, { ws: fakeWs, beaconId });
}

/**
 * Test-only helper: process an incoming message as if it arrived on a
 * beacon's WebSocket. Used to exercise the response-dispatch path without
 * a live server.
 */
export function _handleIncomingMessage(raw: string): void {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type !== 'response' || !msg.id) {
    return;
  }
  const resolver = pendingRequests.get(msg.id);
  if (resolver) {
    pendingRequests.delete(msg.id);
    resolver({ ok: msg.ok, status: msg.status, body: msg.body });
  }
}

/** For tests: clear all connections and pending requests. */
export function resetBeaconConnections(): void {
  for (const conn of connections.values()) {
    try {
      conn.ws.close();
    } catch {
      // best-effort
    }
  }
  connections.clear();
  pendingRequests.clear();
}
