import WebSocket from 'ws';
import type { TlsIdentity } from 'drone-swarm-common/tls';
import { logger } from './logger.js';
import {
  handleSpawnAgent,
  handleListSpawns,
  handleGetSpawn,
  handleTerminateSpawn,
} from './routes/spawn-handlers.js';
import { handleDeliverMessage } from './routes/message-handlers.js';

/**
 * Beacon-side reverse-channel WebSocket client.
 *
 * The beacon opens an outbound WebSocket to the coordinator's `/ws/beacon`
 * endpoint, presenting its TLS client certificate (mTLS). The coordinator
 * pushes spawn/message commands down the channel; this client dispatches them
 * to the shared handlers and replies with the response.
 */

interface CommandMessage {
  type: 'command';
  id: string;
  command: string;
  payload?: Record<string, unknown>;
}

let ws: WebSocket | null = null;
let coordinatorUrl = '';
let tlsIdentity: TlsIdentity | undefined;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;
let attempts = 0;

/**
 * Start the reverse-channel client. Connects to the coordinator's `/ws/beacon`
 * endpoint, reconnecting with exponential backoff on disconnect.
 */
export function startCoordinatorWsClient(
  url: string,
  identity?: TlsIdentity
): void {
  coordinatorUrl = url;
  tlsIdentity = identity;
  stopped = false;
  connect();
}

/** Stop the client and close any open connection. */
export function stopCoordinatorWsClient(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // best-effort
    }
    ws = null;
  }
}

function connect(): void {
  if (stopped || !coordinatorUrl) {
    return;
  }

  logger.info(`Connecting to coordinator reverse channel at ${coordinatorUrl}`);
  const protocol = coordinatorUrl.startsWith('https:') ? 'wss:' : 'ws:';
  const wsUrl = protocol + coordinatorUrl.slice(coordinatorUrl.indexOf('//'));

  const options: WebSocket.ClientOptions = {
    rejectUnauthorized: false, // self-signed coordinator cert; verified via fingerprint pinning elsewhere
  };
  if (tlsIdentity) {
    options.cert = tlsIdentity.certPem;
    options.key = tlsIdentity.keyPem;
  }

  try {
    ws = new WebSocket(`${wsUrl}/ws/beacon`, options);
  } catch (err) {
    logger.warn(`Reverse-channel connection failed: ${err}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    logger.info('Connected to coordinator reverse channel');
  });

  ws.on('message', data => {
    let msg: CommandMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== 'command' || !msg.id) {
      return;
    }
    void handleCommand(msg);
  });

  ws.on('close', () => {
    logger.info('Coordinator reverse channel closed');
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', err => {
    logger.warn(`Reverse-channel error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) {
    return;
  }
  // Exponential backoff starting at 1s, capped at 30s.
  const delay = Math.min(1000 * 2 ** attempts, 30000);
  attempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function handleCommand(msg: CommandMessage): Promise<void> {
  let status = 200;
  let ok = true;
  let body: unknown;

  try {
    switch (msg.command) {
      case 'spawn': {
        const result = await handleSpawnAgent(msg.payload ?? {});
        status = result.status;
        ok = result.status < 400;
        body = result.body;
        break;
      }
      case 'listSpawns': {
        body = handleListSpawns(msg.payload?.status as string | undefined);
        break;
      }
      case 'getSpawn': {
        const result = handleGetSpawn(msg.payload?.spawnId as string);
        status = result.status;
        ok = result.status < 400;
        body = result.body;
        break;
      }
      case 'terminateSpawn': {
        const result = handleTerminateSpawn(msg.payload?.spawnId as string);
        status = result.status;
        ok = result.status < 400;
        body = result.body;
        break;
      }
      case 'deliverMessage': {
        const result = handleDeliverMessage(
          (msg.payload ?? {}) as unknown as Parameters<
            typeof handleDeliverMessage
          >[0]
        );
        status = result.status;
        ok = result.status < 400;
        body = result.body;
        break;
      }
      default:
        status = 400;
        ok = false;
        body = { error: `Unknown command: ${msg.command}` };
    }
  } catch (err) {
    status = 500;
    ok = false;
    body = { error: err instanceof Error ? err.message : 'Unknown error' };
  }

  const response = JSON.stringify({
    type: 'response',
    id: msg.id,
    ok,
    status,
    body,
  });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(response);
  }
}

/** For tests: reset the connection state. */
export function resetCoordinatorWsClient(): void {
  stopCoordinatorWsClient();
  attempts = 0;
}
