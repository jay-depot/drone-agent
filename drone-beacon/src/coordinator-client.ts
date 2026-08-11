import https from 'https';
import http from 'http';
import type { PeerCertificate } from 'tls';
import { generateVerificationCode } from 'drone-swarm-common';
import { logger } from './logger.js';
import {
  isSwarmReady,
  getObservedCoordinatorFingerprint,
} from './coordinator-trust.js';
import type { Persona, Skill, CoordinatorConfig, Knowledge } from './types.js';
import type { BeaconIdentity } from './identity.js';
import type { TlsIdentity } from 'drone-swarm-common/tls';

let didWarnSwarmNotReady = false;

/**
 * True when swarm communications with the coordinator are allowed: the coordinator's
 * TLS fingerprint has been confirmed AND the coordinator has approved this beacon.
 */
function coordinatorTrusted(): boolean {
  if (isSwarmReady()) {
    didWarnSwarmNotReady = false;
    return true;
  }
  if (!didWarnSwarmNotReady) {
    didWarnSwarmNotReady = true;
    logger.warn(
      'Swarm not ready (coordinator fingerprint not confirmed and/or beacon not approved); skipping coordinator sync.'
    );
  }
  return false;
}

export interface BeaconStatusResponse {
  status: 'pending' | 'approved' | 'rejected';
  approvalToken?: string;
}

export interface CoordinatorClient {
  registerBeacon(
    identity: BeaconIdentity,
    tlsFingerprint: string
  ): Promise<{
    status: 'pending' | 'approved' | 'rejected';
    approvalToken?: string;
    verificationCode?: string;
  }>;
  pollForApproval(): Promise<BeaconStatusResponse>;
  heartbeat(): Promise<void>;
  fetchPersonas(): Promise<Persona[]>;
  fetchSkills(): Promise<Skill[]>;

  // Session management
  registerSession(agentId: string, personaId: string | null): Promise<void>;
  endSession(agentId: string, connectedAt: number): Promise<void>;

  // Agent location (for cross-beacon messaging)
  registerAgentLocation(agentId: string, personaId?: string): Promise<void>;
  updateAgentLocationHeartbeat(agentId: string): Promise<void>;
  unregisterAgentLocation(agentId: string): Promise<void>;
  relayMessage(
    toAgentId: string,
    fromAgentId: string,
    body: string
  ): Promise<{ success: boolean; messageId?: string }>;

  // Knowledge sync (push)
  pushPersona(persona: Persona): Promise<void>;
  pushSkill(skill: Skill): Promise<void>;
  deletePersona(id: string): Promise<void>;
  deleteSkill(id: string): Promise<void>;

  // Knowledge sync (global memory)
  pushKnowledge(knowledge: Knowledge): Promise<void>;
  pullKnowledge(since?: number): Promise<Knowledge[]>;
  searchKnowledge(query: string, type?: string): Promise<Knowledge[]>;

  // Swarm session storage
  registerSwarmSession(
    sessionId: string,
    personaId: string | null
  ): Promise<void>;
  updateSwarmSessionPersona(
    sessionId: string,
    personaId: string | null
  ): Promise<void>;
  endSwarmSession(sessionId: string): Promise<void>;
  pushEvents(
    events: Array<{
      id: string;
      sessionId: string;
      correlationId?: string;
      type: string;
      payload?: string;
      metadata?: string;
      createdAt: number;
    }>
  ): Promise<void>;

  // Get the base URL of the coordinator (for proxying)
  getBaseUrl(): string;
  // Tool definition sync
  pushToolDefinitions(
    tools: Array<{
      name: string;
      description: string;
      defaultHidden: boolean;
    }>
  ): Promise<void>;
  getDefaultHiddenTools(): Promise<{ tools: string[] }>;

  // Session pipeline
  getSessions(
    query: Record<string, string>
  ): Promise<{ sessions: any[]; count: number }>;
  getSessionLog(sessionId: string): Promise<any>;
  processSession(sessionId: string): Promise<any>;
  completeSessionProcessing(
    sessionId: string,
    body: { summary?: string; notes?: string }
  ): Promise<any>;
}

export interface SessionInfo {
  id: string;
  agentId: string;
  personaId: string | null;
}

export interface CoordinatorClientOptions {
  identity: BeaconIdentity;
  tlsIdentity: TlsIdentity;
  useHttps?: boolean;
  /** Known SHA-256 fingerprint of the coordinator's TLS certificate (TOFU pinning). */
  coordinatorTlsFingerprint?: string;
  /** Called on first HTTPS connection with the observed fingerprint so callers can persist it. */
  onFirstCoordinatorFingerprint?: (fp: string) => void;
}

/**
 * Build the `checkServerIdentity` override used for coordinator TLS connections.
 *
 * When `expectedFingerprint` is provided the function verifies the server's
 * SHA-256 certificate fingerprint against it, providing TOFU-style MITM
 * protection without a trusted CA.  When no fingerprint is known yet (first
 * connection) `onFirstFingerprint` is called with the observed fingerprint so
 * the caller can persist it.  In that case the connection is still accepted —
 * this is the intentional Trust-On-First-Use window.
 *
 * The function returns `undefined` (no error) when the check passes and returns
 * an `Error` when the fingerprint does not match a known pinned value.
 */
export function buildCheckServerIdentity(
  expectedFingerprint: string | undefined,
  onFirstFingerprint?: (fp: string) => void
): (hostname: string, cert: PeerCertificate) => Error | undefined {
  return (_hostname, cert) => {
    const raw = cert.fingerprint256;
    if (!raw) {
      return new Error('TLS: coordinator certificate has no fingerprint');
    }
    const observed = raw.replace(/:/g, '').toLowerCase();
    if (expectedFingerprint) {
      if (observed !== expectedFingerprint.toLowerCase()) {
        return new Error(
          `TLS: coordinator certificate fingerprint mismatch — expected ${expectedFingerprint} but got ${observed}. Possible MITM attack.`
        );
      }
    } else {
      onFirstFingerprint?.(observed);
    }
    return undefined;
  };
}

/**
 * Create a fetch-compatible function that connects to the coordinator.
 *
 * The coordinator uses a self-signed TLS certificate so standard CA
 * validation is disabled (`rejectUnauthorized: false`).  MITM protection is
 * instead provided by certificate-fingerprint pinning via
 * `checkServerIdentity`: when `expectedCoordinatorFingerprint` is supplied
 * the server certificate is verified against that pinned SHA-256 hash.  On
 * the very first connection — before the fingerprint is known — any
 * certificate is accepted and `onFirstFingerprint` is called so the caller
 * can persist the observed fingerprint for subsequent connections (TOFU).
 *
 * CodeQL note: `rejectUnauthorized: false` is intentional here.  CA
 * validation is inapplicable to self-signed certificates; MITM protection
 * is provided by the `checkServerIdentity` fingerprint check above.
 * lgtm[js/disabling-certificate-verification]
 */
export function createCoordinatorFetch(
  baseUrl: string,
  expectedCoordinatorFingerprint?: string,
  onFirstFingerprint?: (fp: string) => void
): typeof fetch {
  const urlObj = new URL(baseUrl);
  const isHttps = urlObj.protocol === 'https:';

  return async function coordinatorFetch(
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const fullUrl = urlStr.startsWith('http') ? urlStr : `${baseUrl}${urlStr}`;
    const parsedUrl = new URL(fullUrl);

    const method = init?.method ?? 'GET';
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body as string | undefined;

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      if (isHttps) {
        // CA validation is inapplicable for self-signed certs; MITM protection
        // is provided by checkServerIdentity fingerprint pinning instead.
        // lgtm[js/disabling-certificate-verification]
        (options as https.RequestOptions).rejectUnauthorized = false;
        (options as https.RequestOptions).checkServerIdentity =
          buildCheckServerIdentity(
            expectedCoordinatorFingerprint,
            onFirstFingerprint
          );
      }

      const req = (isHttps ? https : http).request(options, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve(
            new Response(bodyBuffer, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? '',
              headers: res.headers as Record<string, string>,
            })
          );
        });
      });

      req.on('error', err => {
        reject(err);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  };
}

export function createCoordinatorClient(
  config: CoordinatorConfig,
  options: CoordinatorClientOptions
): CoordinatorClient {
  const protocol = options.useHttps ? 'https' : 'http';
  const baseUrl = `${protocol}://${config.host}:${config.port}`;
  const cfetch = createCoordinatorFetch(
    baseUrl,
    options.coordinatorTlsFingerprint,
    options.onFirstCoordinatorFingerprint
  );

  return {
    getBaseUrl(): string {
      return baseUrl;
    },

    async registerBeacon(
      identity: BeaconIdentity,
      tlsFingerprint: string
    ): Promise<{
      status: 'pending' | 'approved' | 'rejected';
      approvalToken?: string;
      verificationCode?: string;
    }> {
      logger.info(`Registering beacon with coordinator at ${baseUrl}`);

      const res = await cfetch(`${baseUrl}/api/beacons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: config.beaconId,
          name: config.beaconName,
          host: config.host,
          port: config.port,
          publicKey: identity.publicKey,
          tlsFingerprint,
        }),
      });

      if (!res.ok) {
        throw new Error(
          `Failed to register beacon: ${res.status} ${await res.text()}`
        );
      }

      const data = (await res.json()) as BeaconStatusResponse;
      logger.info(`Beacon registered with status: ${data.status}`);

      if (data.approvalToken) {
        logger.info(`Approval token: ${data.approvalToken}`);
      }

      // Compute the verification code locally from the same inputs the
      // coordinator uses. Both sides should produce the same code.
      const verificationCode = generateVerificationCode(
        identity.publicKey,
        tlsFingerprint,
        getObservedCoordinatorFingerprint() ?? ''
      );

      return {
        status: data.status,
        approvalToken: data.approvalToken,
        verificationCode,
      };
    },

    async pollForApproval(): Promise<BeaconStatusResponse> {
      try {
        const res = await cfetch(
          `${baseUrl}/api/beacons/trust/${config.beaconId}`
        );
        if (!res.ok) {
          if (res.status === 404) {
            return { status: 'pending' };
          }
          throw new Error(`Failed to poll for approval: ${res.status}`);
        }
        return (await res.json()) as BeaconStatusResponse;
      } catch (err) {
        logger.warn(`Failed to poll for approval: ${err}`);
        return { status: 'pending' };
      }
    },

    async heartbeat(): Promise<void> {
      try {
        const res = await cfetch(
          `${baseUrl}/api/beacons/${config.beaconId}/heartbeat`,
          {
            method: 'POST',
          }
        );
        if (!res.ok) {
          logger.warn(`Heartbeat failed: ${res.status}`);
        }
      } catch (err) {
        logger.warn(`Heartbeat failed: ${err}`);
      }
    },

    async fetchPersonas(): Promise<Persona[]> {
      if (!coordinatorTrusted()) {
        return [];
      }
      const res = await cfetch(`${baseUrl}/api/personas`);
      if (!res.ok) {
        throw new Error(`Failed to fetch personas: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const personas = data as Persona[];
      // Mark them as coordinator scope
      return personas.map(p => ({ ...p, scope: 'coordinator' as const }));
    },

    async fetchSkills(): Promise<Skill[]> {
      if (!coordinatorTrusted()) {
        return [];
      }
      const res = await cfetch(`${baseUrl}/api/skills`);
      if (!res.ok) {
        throw new Error(`Failed to fetch skills: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const skills = data as Skill[];
      // Mark them as coordinator scope
      return skills.map(s => ({ ...s, scope: 'coordinator' as const }));
    },

    // Session management
    async registerSession(
      agentId: string,
      personaId: string | null
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(
          `${baseUrl}/api/beacons/${config.beaconId}/sessions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `session-${agentId}-${Date.now()}`,
              agentId,
              personaId: personaId ?? undefined,
            }),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to register session: ${res.status}`);
        } else {
          logger.info(`Registered session for agent ${agentId}`);
        }
      } catch (err) {
        logger.warn(`Failed to register session: ${err}`);
      }
    },

    async endSession(agentId: string, connectedAt: number): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const disconnectedAt = Date.now();
        const durationMs = disconnectedAt - connectedAt;
        const res = await cfetch(
          `${baseUrl}/api/beacons/${config.beaconId}/sessions/${agentId}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              disconnectedAt,
              durationMs,
            }),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to end session: ${res.status}`);
        } else {
          logger.info(
            `Ended session for agent ${agentId}, duration: ${durationMs}ms`
          );
        }
      } catch (err) {
        logger.warn(`Failed to end session: ${err}`);
      }
    },

    // Agent location (for cross-beacon messaging)
    async registerAgentLocation(
      agentId: string,
      personaId?: string
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/agents/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            beaconId: config.beaconId,
            personaId: personaId ?? undefined,
          }),
        });
        if (!res.ok) {
          logger.warn(`Failed to register agent location: ${res.status}`);
        } else {
          logger.info(`Registered agent location: ${agentId}`);
        }
      } catch (err) {
        logger.warn(`Failed to register agent location: ${err}`);
      }
    },

    async updateAgentLocationHeartbeat(agentId: string): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(
          `${baseUrl}/api/agents/location/${agentId}/heartbeat`,
          {
            method: 'POST',
          }
        );
        if (!res.ok) {
          logger.warn(
            `Failed to update agent location heartbeat: ${res.status}`
          );
        }
      } catch (err) {
        logger.warn(`Failed to update agent location heartbeat: ${err}`);
      }
    },

    async unregisterAgentLocation(agentId: string): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/agents/location/${agentId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to unregister agent location: ${res.status}`);
        } else {
          logger.info(`Unregistered agent location: ${agentId}`);
        }
      } catch (err) {
        logger.warn(`Failed to unregister agent location: ${err}`);
      }
    },

    async relayMessage(
      toAgentId: string,
      fromAgentId: string,
      body: string
    ): Promise<{ success: boolean; messageId?: string }> {
      if (!coordinatorTrusted()) {
        return { success: false };
      }
      try {
        const res = await cfetch(`${baseUrl}/api/messages/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromBeaconId: config.beaconId,
            fromAgentId,
            toAgentId,
            body,
          }),
        });
        if (!res.ok) {
          const error = await res.json();
          logger.warn(
            `Failed to relay message: ${res.status} - ${(error as any).error}`
          );
          return { success: false };
        }
        const data = (await res.json()) as { messageId: string };
        return { success: true, messageId: data.messageId };
      } catch (err) {
        logger.warn(`Failed to relay message: ${err}`);
        return { success: false };
      }
    },

    // Knowledge push
    async pushPersona(persona: Persona): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/personas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(persona),
        });
        if (!res.ok) {
          logger.warn(`Failed to push persona: ${res.status}`);
        } else {
          logger.info(`Pushed persona ${persona.id} to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push persona: ${err}`);
      }
    },

    async pushSkill(skill: Skill): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(skill),
        });
        if (!res.ok) {
          logger.warn(`Failed to push skill: ${res.status}`);
        } else {
          logger.info(`Pushed skill ${skill.id} to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push skill: ${err}`);
      }
    },

    async deletePersona(id: string): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/personas/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to delete persona: ${res.status}`);
        } else {
          logger.info(`Deleted persona ${id} from coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to delete persona: ${err}`);
      }
    },

    async deleteSkill(id: string): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/skills/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to delete skill: ${res.status}`);
        } else {
          logger.info(`Deleted skill ${id} from coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to delete skill: ${err}`);
      }
    },

    // Knowledge sync (global memory)
    async pushKnowledge(knowledge: Knowledge): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sync/knowledge/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(knowledge),
        });
        if (!res.ok) {
          logger.warn(`Failed to push knowledge: ${res.status}`);
        } else {
          logger.info(`Pushed knowledge ${knowledge.id} to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push knowledge: ${err}`);
      }
    },

    async pullKnowledge(since?: number): Promise<Knowledge[]> {
      if (!coordinatorTrusted()) {
        return [];
      }
      try {
        let url = `${baseUrl}/api/sync/knowledge/pull`;
        if (since) {
          url += `?since=${since}`;
        }
        const res = await cfetch(url);
        if (!res.ok) {
          logger.warn(`Failed to pull knowledge: ${res.status}`);
          return [];
        }
        return (await res.json()) as Knowledge[];
      } catch (err) {
        logger.warn(`Failed to pull knowledge: ${err}`);
        return [];
      }
    },

    async searchKnowledge(query: string, type?: string): Promise<Knowledge[]> {
      if (!coordinatorTrusted()) {
        return [];
      }
      try {
        let url = `${baseUrl}/api/knowledge/search?q=${encodeURIComponent(query)}`;
        if (type) {
          url += `&type=${encodeURIComponent(type)}`;
        }
        const res = await cfetch(url);
        if (!res.ok) {
          logger.warn(`Failed to search knowledge: ${res.status}`);
          return [];
        }
        return (await res.json()) as Knowledge[];
      } catch (err) {
        logger.warn(`Failed to search knowledge: ${err}`);
        return [];
      }
    },

    // Swarm session storage
    async registerSwarmSession(
      sessionId: string,
      personaId: string | null
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sync/sessions/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: sessionId,
            personaId: personaId ?? undefined,
            beaconId: config.beaconId,
          }),
        });
        if (!res.ok) {
          logger.warn(`Failed to register swarm session: ${res.status}`);
        } else {
          logger.info(`Registered swarm session ${sessionId}`);
        }
      } catch (err) {
        logger.warn(`Failed to register swarm session: ${err}`);
      }
    },

    async updateSwarmSessionPersona(
      sessionId: string,
      personaId: string | null
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(
          `${baseUrl}/api/sessions/${sessionId}/persona`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personaId }),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to update session persona: ${res.status}`);
        }
      } catch (err) {
        logger.warn(`Failed to update session persona: ${err}`);
      }
    },

    async endSwarmSession(sessionId: string): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sync/sessions/${sessionId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          logger.warn(`Failed to end swarm session: ${res.status}`);
        } else {
          logger.info(`Ended swarm session ${sessionId}`);
        }
      } catch (err) {
        logger.warn(`Failed to end swarm session: ${err}`);
      }
    },

    async pushEvents(
      events: Array<{
        id: string;
        sessionId: string;
        correlationId?: string;
        type: string;
        payload?: string;
        metadata?: string;
        createdAt: number;
      }>
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sync/events/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
        });
        if (!res.ok) {
          logger.warn(`Failed to push events: ${res.status}`);
        } else {
          logger.debug(`Pushed ${events.length} events to coordinator`);
        }
      } catch (err) {
        logger.warn(`Failed to push events: ${err}`);
      }
    },

    async pushToolDefinitions(
      tools: Array<{
        name: string;
        description: string;
        defaultHidden: boolean;
      }>
    ): Promise<void> {
      if (!coordinatorTrusted()) {
        return;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sync/tools/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools }),
        });
        if (!res.ok) {
          logger.warn(`Failed to push tool definitions: ${res.status}`);
        } else {
          logger.debug(
            `Pushed ${tools.length} tool definitions to coordinator`
          );
        }
      } catch (err) {
        logger.warn(`Failed to push tool definitions: ${err}`);
      }
    },

    async getDefaultHiddenTools(): Promise<{ tools: string[] }> {
      if (!coordinatorTrusted()) {
        return { tools: [] };
      }
      try {
        const res = await cfetch(`${baseUrl}/api/tools/default-hidden`);
        if (!res.ok) {
          logger.warn(`Failed to get default hidden tools: ${res.status}`);
          return { tools: [] };
        }
        return (await res.json()) as { tools: string[] };
      } catch (err) {
        logger.warn(`Failed to get default hidden tools: ${err}`);
        return { tools: [] };
      }
    },

    async getSessions(
      query: Record<string, string>
    ): Promise<{ sessions: any[]; count: number }> {
      if (!coordinatorTrusted()) {
        return { sessions: [], count: 0 };
      }
      try {
        const params = new URLSearchParams(query).toString();
        const res = await cfetch(`${baseUrl}/api/sessions?${params}`);
        if (!res.ok) {
          logger.warn(`Failed to get sessions: ${res.status}`);
          return { sessions: [], count: 0 };
        }
        return (await res.json()) as { sessions: any[]; count: number };
      } catch (err) {
        logger.warn(`Failed to get sessions: ${err}`);
        return { sessions: [], count: 0 };
      }
    },

    async getSessionLog(sessionId: string): Promise<any> {
      if (!coordinatorTrusted()) {
        return null;
      }
      try {
        const res = await cfetch(`${baseUrl}/api/sessions/${sessionId}/log`);
        if (!res.ok) {
          logger.warn(`Failed to get session log: ${res.status}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        logger.warn(`Failed to get session log: ${err}`);
        return null;
      }
    },

    async processSession(sessionId: string): Promise<any> {
      if (!coordinatorTrusted()) {
        return null;
      }
      try {
        const res = await cfetch(
          `${baseUrl}/api/sessions/${sessionId}/process`,
          {
            method: 'POST',
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to process session: ${res.status}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        logger.warn(`Failed to process session: ${err}`);
        return null;
      }
    },

    async completeSessionProcessing(
      sessionId: string,
      body: { summary?: string; notes?: string }
    ): Promise<any> {
      if (!coordinatorTrusted()) {
        return null;
      }
      try {
        const res = await cfetch(
          `${baseUrl}/api/sessions/${sessionId}/processed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) {
          logger.warn(`Failed to complete session processing: ${res.status}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        logger.warn(`Failed to complete session processing: ${err}`);
        return null;
      }
    },
  };
}
