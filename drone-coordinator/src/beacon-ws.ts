import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import {
  getClientCertFingerprint,
  resolveBeaconIdByFingerprint,
} from './mtls.js';
import {
  getBeaconTrust,
  getSwarmSession,
  upsertCapabilityCache,
  listActiveSessionSnapshots,
} from './db/index.js';
import { publishMutationEvent } from './ws-pubsub.js';
import { logger } from './logger.js';
import {
  setManifest,
  getManifest,
  clearManifest,
  recordInjection,
  removeInjectionRecord,
  listInjections,
} from './extension-registry.js';
import {
  EXTENSION_PROTOCOL_VERSION,
  type DroneInjectFrame,
  type DroneInjectRemoveFrame,
  type DroneManifestFrame,
  type DroneSessionSnapshot,
} from 'drone-core';

/**
 * Decide whether a beacon connection over the reverse channel should be
 * admitted. A PENDING (or unknown) beacon's certificate resolves via the
 * fingerprint map, but it must not receive spawn/message commands until the
 * operator approves it. Returns the WebSocket close code + reason to refuse,
 * or null to admit the connection.
 */
export function resolveBeaconWsAdmission(
  beaconId: string
): { code: number; reason: string } | null {
  const trust = getBeaconTrust(beaconId);
  if (!trust || trust.status !== 'approved') {
    return { code: 4002, reason: 'Beacon not yet approved' };
  }
  return null;
}

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
  isAlive: boolean;
}

const connections = new Map<string, BeaconConnection>();

/**
 * Test-visible hook registration point. The connect/disconnect lifecycle
 * publishes beacon.connected / beacon.disconnected events; tests spy on these
 * callbacks to observe those publishes without a live WebSocket.
 */
const lifecycleHooks: {
  onConnected?: (beaconId: string) => void;
  onDisconnected?: (beaconId: string) => void;
} = {};

/** Internal: add a beacon connection and fire the connected hook. */
function registerBeaconConnection(
  beaconId: string,
  ws: WebSocket
): BeaconConnection {
  const conn: BeaconConnection = { ws, beaconId, isAlive: true };
  connections.set(beaconId, conn);
  logger.info(`Beacon ${beaconId} connected via reverse-channel WebSocket`);
  ws.on('pong', () => {
    conn.isAlive = true;
  });
  // Replay `sessionStarted` for currently-active sessions so a node that just
  // connected (e.g. a restarted extension) recovers the sessions it missed.
  replayActiveSessions(conn);
  publishMutationEvent({
    sessionId: beaconId,
    eventType: 'beacon.connected',
    payload: { beaconId },
  });
  lifecycleHooks.onConnected?.(beaconId);
  return conn;
}

/** Internal: remove a beacon connection and fire the disconnected hook. */
function unregisterBeaconConnection(beaconId: string): void {
  const removed = connections.delete(beaconId);
  if (!removed) return;
  logger.info(`Beacon ${beaconId} disconnected from reverse-channel WebSocket`);
  publishMutationEvent({
    sessionId: beaconId,
    eventType: 'beacon.disconnected',
    payload: { beaconId },
  });
  lifecycleHooks.onDisconnected?.(beaconId);
  // Drop any capability manifest and clean up this node's injections.
  void cleanupExtension(beaconId);
}

// Pending command requests awaiting a response: id -> resolver
const pendingRequests = new Map<string, (res: CommandResponse) => void>();

export interface CommandResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

interface IncomingMessage {
  type: string;
  id?: string;
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/**
 * Resolve the host beacon of a session target so an injection can be forwarded
 * to the right node. Falls back to the target itself (the target may be a
 * beacon id in ad-hoc cases).
 */
function resolveHostBeacon(target: string): string | undefined {
  const session = getSwarmSession(target);
  return session?.beaconId ?? target;
}

/** Apply a `manifest` frame: register, cache, and publish a mutation event. */
function handleManifestFrame(beaconId: string, msg: IncomingMessage): void {
  const manifest = msg as unknown as DroneManifestFrame;
  if (manifest.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
    logger.warn(
      `Rejecting manifest from ${beaconId}: protocolVersion ${manifest.protocolVersion} != ${EXTENSION_PROTOCOL_VERSION}`
    );
    return;
  }
  const normalized = {
    protocolVersion: manifest.protocolVersion,
    capabilities: manifest.capabilities ?? [],
    bundles: manifest.bundles ?? [],
  };
  setManifest(beaconId, normalized);
  upsertCapabilityCache(beaconId, normalized);
  logger.info(
    `Extension manifest from ${beaconId}: ${normalized.capabilities.length} capability(ies)`
  );
  publishMutationEvent({
    sessionId: beaconId,
    eventType: 'extension.manifest',
    payload: { beaconId },
  });
}

/**
 * Forward a command to a host beacon, fire-and-forget. Injection transport is
 * best-effort: a missing host beacon or a non-response is logged, never
 * thrown, and never blocks the inbound frame dispatch.
 */
function forwardCommand(
  hostBeaconId: string,
  command: string,
  payload: unknown
): void {
  void sendBeaconCommand(hostBeaconId, command, payload).catch((err: unknown) =>
    logger.warn(`Failed to forward ${command} to ${hostBeaconId}: ${err}`)
  );
}

/** Forward an `inject` frame to the target session's host beacon. */
function handleInjectFrame(beaconId: string, msg: IncomingMessage): void {
  const frame = msg as unknown as DroneInjectFrame;
  const hostBeaconId = resolveHostBeacon(frame.target);
  if (!hostBeaconId) {
    logger.warn(`inject: unknown target session ${frame.target}`);
    return;
  }
  recordInjection(beaconId, {
    target: frame.target,
    injectionId: frame.id,
    kind: frame.kind,
    hostBeaconId,
    tools: frame.tools,
  });
  forwardCommand(hostBeaconId, 'inject', {
    extensionId: beaconId,
    ...frame,
    tools: resolveToolSelections(beaconId, frame.tools),
  });
}

/**
 * Enrich a tools injection's selections with the resolved capability metadata
 * from the extension's manifest, so the agent-side tool definition carries
 * the real description + param schema (single source of truth = the
 * manifest). Unresolvable capabilities pass through name-only.
 */
function resolveToolSelections(
  extensionId: string,
  tools: Array<{ capability: string }> | undefined
): Array<{ capability: string; description?: string; paramSchema?: unknown }> | undefined {
  if (!tools) return undefined;
  const manifest = getManifest(extensionId);
  return tools.map(t => {
    const cap = manifest?.capabilities.find(c => c.name === t.capability);
    return cap
      ? {
          capability: t.capability,
          description: cap.description,
          paramSchema: cap.paramSchema,
        }
      : { capability: t.capability };
  });
}

/** Forward an `inject-remove` frame to the target session's host beacon. */
function handleInjectRemoveFrame(
  beaconId: string,
  msg: IncomingMessage
): void {
  const frame = msg as unknown as DroneInjectRemoveFrame;
  const hostBeaconId = resolveHostBeacon(frame.target);
  if (!hostBeaconId) {
    logger.warn(`inject-remove: unknown target session ${frame.target}`);
    return;
  }
  if (frame.injectionId) {
    removeInjectionRecord(beaconId, frame.target, frame.injectionId);
  }
  forwardCommand(hostBeaconId, 'injectRemove', {
    extensionId: beaconId,
    ...frame,
  });
}

/** Dispatch one inbound node frame. Shared by the live socket + test helper. */
function dispatchIncoming(beaconId: string, raw: string): void {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'response': {
      if (!msg.id) return;
      const resolver = pendingRequests.get(msg.id);
      if (resolver) {
        pendingRequests.delete(msg.id);
        resolver({ ok: msg.ok ?? false, status: msg.status, body: msg.body });
      }
      return;
    }
    case 'manifest':
      handleManifestFrame(beaconId, msg);
      return;
    case 'inject':
      void handleInjectFrame(beaconId, msg);
      return;
    case 'inject-remove':
      void handleInjectRemoveFrame(beaconId, msg);
      return;
    default:
      return;
  }
}

/** Drop a node's manifest and clean up every injection it pushed. */
async function cleanupExtension(beaconId: string): Promise<void> {
  const injections = listInjections(beaconId);
  clearManifest(beaconId);
  for (const record of injections) {
    try {
      await sendBeaconCommand(record.hostBeaconId, 'injectRemove', {
        extensionId: beaconId,
        target: record.target,
        kind: record.kind,
        injectionId: record.injectionId,
      });
    } catch (err) {
      logger.warn(
        `injection cleanup for ${beaconId} on ${record.hostBeaconId} failed: ${err}`
      );
    }
  }
}

/**
 * Replay `sessionStarted` for every currently-active session to a
 * just-connected node, so a restarted extension recovers sessions it missed
 * while offline. Best-effort: never throws into the connect path.
 */
function replayActiveSessions(conn: BeaconConnection): void {
  let sessions: DroneSessionSnapshot[];
  try {
    sessions = listActiveSessionSnapshots();
  } catch (err) {
    logger.warn(`Failed to replay active sessions to ${conn.beaconId}: ${err}`);
    return;
  }
  for (const session of sessions) {
    conn.ws.send(
      JSON.stringify({ type: 'event', event: 'sessionStarted', session }),
      (err?: Error) => {
        if (err) {
          logger.warn(
            `Failed to replay sessionStarted to ${conn.beaconId}: ${err}`
          );
        }
      }
    );
  }
}

/**
 * Register the `/ws/beacon` endpoint on the coordinator's primary app.
 * The WebSocket plugin must already be registered on `app`.
 */
export function registerBeaconWebSocket(app: FastifyInstance): void {
  app.get('/ws/beacon', { websocket: true }, (socket, request) => {
    const fingerprint = getClientCertFingerprint(
      request as unknown as FastifyRequest
    );
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

    const refusal = resolveBeaconWsAdmission(beaconId);
    if (refusal) {
      logger.warn(
        `Rejected beacon WebSocket connection: beacon ${beaconId} not yet approved`
      );
      socket.close(refusal.code, refusal.reason);
      return;
    }

    registerBeaconConnection(beaconId, socket);

    socket.on('message', (raw: Buffer) => {
      dispatchIncoming(beaconId, raw.toString());
    });

    socket.on('close', () => {
      unregisterBeaconConnection(beaconId);
    });
  });
}

/**
 * Half-open connection detection: periodically ping every beacon's reverse
 * channel. A beacon that fails to pong by the next sweep is terminated so dead
 * sockets don't keep `isBeaconConnected` reporting true forever.
 *
 * Returns the interval so callers can clear it on shutdown. The interval is
 * unref'd so it never keeps the process alive by itself.
 */
export function startBeaconLivenessSweep(intervalMs = 30000): NodeJS.Timeout {
  const interval = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.isAlive) {
        conn.ws.terminate();
        // Terminate fires 'close' (which also unregisters), but unregister
        // explicitly so the map and disconnected publish are deterministic.
        unregisterBeaconConnection(conn.beaconId);
        continue;
      }
      conn.isAlive = false;
      conn.ws.ping();
    }
  }, intervalMs);
  interval.unref();
  return interval;
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

/** Ids of all beacons with an open reverse-channel connection. */
export function getConnectedBeaconIds(): string[] {
  return [...connections.keys()];
}

/**
 * Fire a payload-less command at every connected beacon over its reverse
 * channel. Best-effort: one failed send never throws to the caller, and a
 * beacon that is offline simply misses the nudge (it self-heals on its next
 * periodic sync, which remains the source of truth).
 */
export function broadcastBeaconCommand(command: string): void {
  for (const beaconId of getConnectedBeaconIds()) {
    const conn = connections.get(beaconId);
    if (!conn) continue;
    const message = JSON.stringify({
      type: 'command',
      id: randomUUID(),
      command,
    });
    conn.ws.send(message, (err?: Error) => {
      if (err) {
        logger.warn(
          `Failed to broadcast "${command}" to beacon ${beaconId}: ${err}`
        );
      }
    });
  }
}

/** Nudge every connected beacon to re-pull coordinator config immediately. */
export function notifyConfigChanged(): void {
  broadcastBeaconCommand('configChanged');
}

/** Nudge every connected beacon to re-pull coordinator fragments immediately. */
export function notifyFragmentsChanged(): void {
  broadcastBeaconCommand('fragmentsChanged');
}

/**
 * Test-only helper: register a connection with a fake WebSocket so
 * `sendBeaconCommand` can be exercised without a live server.
 */
export function _registerTestConnection(
  beaconId: string,
  fakeWs: WebSocket
): void {
  registerBeaconConnection(beaconId, fakeWs);
}

/**
 * Test-only helper: install lifecycle hooks so tests can observe the
 * connected/disconnected publishes without a live WebSocket.
 */
export function _setLifecycleHooks(hooks: {
  onConnected?: (beaconId: string) => void;
  onDisconnected?: (beaconId: string) => void;
}): void {
  lifecycleHooks.onConnected = hooks.onConnected;
  lifecycleHooks.onDisconnected = hooks.onDisconnected;
}

/** Test-only helper: disconnect a single node, firing its close cleanup. */
export function _disconnectTestConnection(beaconId: string): void {
  unregisterBeaconConnection(beaconId);
}

/** Test-only helper: expose whether a beacon is connected, for liveness tests. */
export function _getConnection(
  beaconId: string
): { isAlive: boolean } | undefined {
  const conn = connections.get(beaconId);
  return conn ? { isAlive: conn.isAlive } : undefined;
}

/**
 * Test-only helper: process an incoming message as if it arrived on a
 * beacon's WebSocket. Used to exercise the response-dispatch path without
 * a live server.
 */
export function _handleIncomingMessage(raw: string, beaconId = 'test'): void {
  dispatchIncoming(beaconId, raw);
}

/** For tests: clear all connections and pending requests. */
export function resetBeaconConnections(): void {
  for (const beaconId of [...connections.keys()]) {
    const conn = connections.get(beaconId);
    if (!conn) continue;
    try {
      conn.ws.close();
    } catch {
      // best-effort
    }
    unregisterBeaconConnection(beaconId);
  }
  pendingRequests.clear();
  lifecycleHooks.onConnected = undefined;
  lifecycleHooks.onDisconnected = undefined;
}

/**
 * Push an `event` frame to every connected node over its reverse channel.
 * Best-effort: a send failure is logged, never thrown.
 */
export function broadcastBeaconEvent(event: unknown): void {
  for (const beaconId of getConnectedBeaconIds()) {
    const conn = connections.get(beaconId);
    if (!conn) continue;
    conn.ws.send(JSON.stringify(event), (err?: Error) => {
      if (err) {
        logger.warn(`Failed to broadcast event to node ${beaconId}: ${err}`);
      }
    });
  }
}
