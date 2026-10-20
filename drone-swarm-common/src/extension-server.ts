import WebSocket from 'ws';
import { loadOrCreateIdentity } from './identity.js';
import { loadOrCreateTlsIdentity, type TlsIdentity } from './tls.js';
import { createCoordinatorFetch } from './coordinator-fetch.js';
import { loadCoordinatorTrust } from './coordinator-trust.js';
import { logger } from './logger.js';
import {
  EXTENSION_PROTOCOL_VERSION,
  type DroneExtensionCapability,
  type DroneExtensionManifest,
  type DroneSessionSnapshot,
  type DroneSessionEndedEvent,
} from 'drone-core';

/**
 * SDK for a swarm extension node: an external service that connects to the
 * coordinator over the beacon protocol and additionally declares a capability
 * manifest. Owns identity/TLS generation, registration, the reverse-channel
 * WebSocket (connect + reconnect), manifest declaration, inbound command/event
 * dispatch, and injection/base upload helpers.
 *
 * v0 is local-only. The node connects to the coordinator's unencrypted web
 * port, which is bound to loopback. With no client certificate the node id is
 * claimed (ADR 257), and registration is auto-approved because the caller is
 * local. Pointing the node at an `https:` coordinator URL keeps the mTLS path,
 * but the SDK does not implement the mTLS approval handshake, so such a node
 * stays pending.
 */

export interface InvokeCtx {
  /** Caller kind: a UI/external action or an agent tool call. */
  caller: 'ui' | 'agent';
  /** Agent session id for tool calls; undefined for UI actions. */
  sessionId?: string;
}

export interface InvokeResult {
  ok: boolean;
  status?: number;
  body?: unknown;
}

export interface ExtensionNodeHandlers {
  onInvokeAction?: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
  onInvokeTool?: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
  onSessionStarted?: (snapshot: DroneSessionSnapshot) => void | Promise<void>;
  onSessionEnded?: (session: DroneSessionEndedEvent) => void | Promise<void>;
}

export interface BundleFileInput {
  name: string;
  contentBase64: string;
  contentType?: string;
}

export interface ExtensionNode {
  /** mTLS-authenticated fetch bound to the coordinator (TOFU-pinned). */
  getFetch(): typeof fetch;
  /** Push a persistent prompt fragment into a target session. */
  injectFragment(input: {
    target: string;
    id: string;
    content: string;
    phase?: 'header' | 'footer';
    ttlMs?: number;
  }): void;
  /** Queue a one-shot system reminder into a target session. */
  injectReminder(input: { target: string; id: string; content: string }): void;
  /** Select capabilities from the catalog as tools for a target session. */
  injectTools(input: { target: string; capabilities: string[] }): void;
  /** Remove a prior injection (or all of a kind when injectionId is omitted). */
  removeInjection(input: {
    target: string;
    kind: 'fragment' | 'reminder' | 'tools';
    injectionId?: string;
    tools?: string[];
  }): void;
  /** Re-declare the manifest (replace semantics). */
  declareManifest(manifest: DroneExtensionManifest): void;
  /** Upload/replace a front-end bundle. */
  uploadBundle(input: {
    name: string;
    version: string;
    files: BundleFileInput[];
  }): Promise<{ hash: string }>;
  /** Close the WebSocket and stop reconnecting. */
  stop(): Promise<void>;
}

export interface CreateExtensionNodeOptions {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  name: string;
  capabilities: DroneExtensionCapability[];
  handlers?: ExtensionNodeHandlers;
  /**
   * The address other swarm members should use to reach this node. Extensions
   * have no listen port, so no port is registered. v0 extensions are
   * local-only, so this defaults to loopback (ADR 257).
   */
  host?: string;
  /**
   * When `false`, `createExtensionNode` resolves before registration completes
   * and retries registration in the background with exponential backoff. When
   * `true` (the default), a registration failure no longer rejects: the node
   * opens the socket (which the coordinator will refuse until it is registered)
   * and retries registration in the background.
   */
  awaitRegistration?: boolean;
  /** Bounded timeout for coordinator HTTP requests. Unset means no timeout. */
  requestTimeoutMs?: number;
  /**
   * The coordinator's TLS certificate fingerprint (hex, no colons). When set,
   * the node pins it and refuses a mismatch (no TOFU). When unset, the node
   * reads `<dataDir>/coordinator-trust.json` if present.
   */
  expectedCoordinatorFingerprint?: string;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REGISTER_RETRY_MIN_MS = 1000;
const REGISTER_RETRY_MAX_MS = 30000;

export async function createExtensionNode(
  opts: CreateExtensionNodeOptions
): Promise<ExtensionNode> {
  const host = opts.host ?? '127.0.0.1';
  const identity = await loadOrCreateIdentity(
    opts.id,
    opts.dataDir,
    'node-identity.json'
  );
  const tlsIdentity: TlsIdentity = await loadOrCreateTlsIdentity(
    opts.dataDir,
    'node'
  );
  const pinnedFingerprint =
    opts.expectedCoordinatorFingerprint ??
    (await loadCoordinatorTrust(opts.dataDir))?.tlsFingerprint;
  const cfetch = createCoordinatorFetch(
    opts.coordinatorUrl,
    pinnedFingerprint,
    undefined,
    tlsIdentity,
    opts.requestTimeoutMs
  );

  let manifest: DroneExtensionManifest = {
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    capabilities: opts.capabilities,
    bundles: [],
  };

  let ws: WebSocket | null = null;
  let stopped = false;
  let attempts = 0;
  let admitted = false;
  let policyCloseLogged = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let registerAttempts = 0;
  let registerTimer: NodeJS.Timeout | null = null;

  const register = async (): Promise<void> => {
    const res = await cfetch(`${opts.coordinatorUrl}/api/beacons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: opts.id,
        name: opts.name,
        host,
        publicKey: identity.publicKey,
        tlsFingerprint: tlsIdentity.fingerprint,
        fingerprintConfirmed: false,
        extension: { protocolVersion: EXTENSION_PROTOCOL_VERSION },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to register extension node: ${res.status} ${await res.text()}`
      );
    }
  };

  const send = (frame: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  };

  const dispatchCommand = async (msg: {
    id: string;
    command: string;
    payload?: Record<string, unknown>;
  }): Promise<void> => {
    let ok = true;
    let status: number | undefined;
    let body: unknown;
    try {
      const payload = msg.payload ?? {};
      const action = payload.action as string | undefined;
      const params = payload.params;
      const ctx: InvokeCtx = {
        caller: (payload.caller as 'ui' | 'agent') ?? 'ui',
        sessionId: payload.sessionId as string | undefined,
      };
      if (msg.command === 'invokeAction') {
        if (!opts.handlers?.onInvokeAction || !action) {
          status = 404;
          ok = false;
          body = { error: 'Unknown action' };
        } else {
          const result = await opts.handlers.onInvokeAction(
            action,
            params,
            ctx
          );
          ({ ok, status = ok ? 200 : 502, body } = result);
        }
      } else if (msg.command === 'invokeTool') {
        if (!opts.handlers?.onInvokeTool || !action) {
          status = 404;
          ok = false;
          body = { error: 'Unknown tool' };
        } else {
          const result = await opts.handlers.onInvokeTool(action, params, ctx);
          ({ ok, status = ok ? 200 : 502, body } = result);
        }
      } else {
        status = 400;
        ok = false;
        body = { error: `Unknown command: ${msg.command}` };
      }
    } catch (err) {
      status = 500;
      ok = false;
      body = { error: err instanceof Error ? err.message : 'Unknown error' };
    }
    send({ type: 'response', id: msg.id, ok, status, body });
  };

  const dispatchEvent = (msg: {
    event: 'sessionStarted' | 'sessionEnded';
    session: unknown;
  }): void => {
    try {
      if (msg.event === 'sessionStarted' && opts.handlers?.onSessionStarted) {
        void opts.handlers.onSessionStarted(
          msg.session as DroneSessionSnapshot
        );
      } else if (
        msg.event === 'sessionEnded' &&
        opts.handlers?.onSessionEnded
      ) {
        void opts.handlers.onSessionEnded(
          msg.session as DroneSessionEndedEvent
        );
      }
    } catch (err) {
      logger.warn(`Extension event handler failed: ${err}`);
    }
  };

  const connect = (): void => {
    if (stopped) return;
    const wsUrl = opts.coordinatorUrl.replace(/^http/, 'ws') + '/ws/beacon';
    const certless = !opts.coordinatorUrl.startsWith('https:');
    const target = certless
      ? `${wsUrl}?beaconId=${encodeURIComponent(opts.id)}`
      : wsUrl;
    const wsOptions: WebSocket.ClientOptions = certless
      ? { headers: { 'x-node-id': opts.id } }
      : {
          // codeql[js/disabling-certificate-verification]
          rejectUnauthorized: false,
          cert: tlsIdentity.certPem,
          key: tlsIdentity.keyPem,
        };
    try {
      ws = new WebSocket(target, wsOptions);
    } catch (err) {
      logger.warn(`Extension node WS connect failed: ${err}`);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      logger.info(`Extension node ${opts.id} socket open, awaiting admission`);
      send({ type: 'manifest', ...manifest });
    });

    ws.on('upgrade', res => {
      const socket = res.socket as unknown as {
        getPeerCertificate?: () => { fingerprint256?: string } | false;
        destroy?: () => void;
      };
      const cert = socket.getPeerCertificate?.();
      const fp =
        cert && typeof cert !== 'boolean'
          ? cert.fingerprint256?.replace(/:/g, '').toLowerCase()
          : undefined;
      if (pinnedFingerprint && fp && fp !== pinnedFingerprint.toLowerCase()) {
        socket.destroy?.();
        logger.warn(
          `Coordinator TLS fingerprint mismatch on WS upgrade; refusing socket`
        );
      }
    });

    ws.on('message', data => {
      let msg: { type: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'event' && !admitted) {
        admitted = true;
        attempts = 0;
        policyCloseLogged = false;
        logger.info(`Extension node ${opts.id} admitted to coordinator`);
      }
      if (msg.type === 'command') {
        void dispatchCommand(
          msg as unknown as {
            id: string;
            command: string;
            payload?: Record<string, unknown>;
          }
        );
      } else if (msg.type === 'event') {
        dispatchEvent(
          msg as unknown as {
            event: 'sessionStarted' | 'sessionEnded';
            session: unknown;
          }
        );
      }
    });

    ws.on('close', (code: number) => {
      ws = null;
      const wasAdmitted = admitted;
      admitted = false;
      if (
        !wasAdmitted &&
        (code === 4001 || code === 4002) &&
        !policyCloseLogged
      ) {
        logger.warn(
          `Extension node ${opts.id} was not admitted by the coordinator (close code ${code}); retrying with backoff`
        );
        policyCloseLogged = true;
      }
      if (wasAdmitted) {
        attempts = 0;
      }
      scheduleReconnect();
    });

    ws.on('error', err => {
      logger.warn(`Extension node WS error: ${err.message}`);
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const scheduleRegisterRetry = (): void => {
    if (stopped || registerTimer) return;
    const delay = Math.min(
      REGISTER_RETRY_MIN_MS * 2 ** registerAttempts,
      REGISTER_RETRY_MAX_MS
    );
    registerAttempts++;
    registerTimer = setTimeout(() => {
      registerTimer = null;
      void tryRegister();
    }, delay);
  };

  const tryRegister = async (): Promise<void> => {
    if (stopped) return;
    try {
      await register();
      registerAttempts = 0;
      connect();
    } catch (err) {
      logger.warn(`Extension node registration failed: ${err}`);
      scheduleRegisterRetry();
    }
  };

  if (opts.awaitRegistration === false) {
    void tryRegister();
  } else {
    try {
      await register();
      connect();
    } catch (err) {
      logger.warn(`Extension node registration failed: ${err}`);
      connect();
      scheduleRegisterRetry();
    }
  }

  return {
    getFetch() {
      return cfetch;
    },
    injectFragment(input) {
      send({
        type: 'inject',
        id: input.id,
        target: input.target,
        kind: 'fragment',
        content: input.content,
        phase: input.phase ?? 'header',
        ttlMs: input.ttlMs,
      });
    },
    injectReminder(input) {
      send({
        type: 'inject',
        id: input.id,
        target: input.target,
        kind: 'reminder',
        content: input.content,
      });
    },
    injectTools(input) {
      send({
        type: 'inject',
        id: `tools:${Date.now()}`,
        target: input.target,
        kind: 'tools',
        tools: input.capabilities.map(capability => ({ capability })),
      });
    },
    removeInjection(input) {
      send({
        type: 'inject-remove',
        target: input.target,
        kind: input.kind,
        injectionId: input.injectionId,
        tools: input.tools?.map(capability => ({ capability })),
      });
    },
    declareManifest(next) {
      manifest = next;
      send({ type: 'manifest', ...manifest });
    },
    async uploadBundle(input) {
      const certless = !opts.coordinatorUrl.startsWith('https:');
      const res = await cfetch(
        `${opts.coordinatorUrl}/api/extensions/bundles/${encodeURIComponent(input.name)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            // On the unencrypted web port there is no client certificate, so
            // the node claims its id (ADR 257).
            ...(certless ? { 'x-node-id': opts.id } : {}),
          },
          body: JSON.stringify({ version: input.version, files: input.files }),
        }
      );
      if (!res.ok) {
        throw new Error(
          `Bundle upload failed: ${res.status} ${await res.text()}`
        );
      }
      return (await res.json()) as { hash: string };
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (registerTimer) {
        clearTimeout(registerTimer);
        registerTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
        ws = null;
      }
    },
  };
}
