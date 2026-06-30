import https from 'https';
import http from 'http';
import { logger } from './logger.js';
import type { Persona, Skill, CoordinatorConfig, Knowledge } from './types.js';
import type { BeaconIdentity } from './identity.js';
import type { TlsIdentity } from './tls.js';

export interface BeaconStatusResponse {
  status: 'pending' | 'approved' | 'rejected' | 'rejected';
  approvalToken?: string;
}

export interface CoordinatorClient {
  registerBeacon(
    identity: BeaconIdentity,
    tlsFingerprint: string
  ): Promise<{
    status: 'pending' | 'approved' | 'rejected';
    approvalToken?: string;
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
}

/**
 * Create a fetch-compatible function that accepts self-signed TLS certificates.
 * The coordinator uses a self-signed cert, so Node.js's built-in fetch rejects it.
 * This wrapper uses Node.js http/https modules with rejectUnauthorized: false.
 */
export function createCoordinatorFetch(baseUrl: string): typeof fetch {
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

      // For HTTPS connections to the coordinator (which uses a self-signed cert),
      // disable certificate validation
      if (isHttps) {
        (options as https.RequestOptions).rejectUnauthorized = false;
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
  const cfetch = createCoordinatorFetch(baseUrl);

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
    }> {
      logger.info(`Registering beacon with coordinator at ${baseUrl}`);

      const res = await cfetch(`${baseUrl}/beacons`, {
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

      return { status: data.status, approvalToken: data.approvalToken };
    },

    async pollForApproval(): Promise<BeaconStatusResponse> {
      try {
        const res = await cfetch(`${baseUrl}/beacons/trust/${config.beaconId}`);
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
          `${baseUrl}/beacons/${config.beaconId}/heartbeat`,
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
      const res = await cfetch(`${baseUrl}/personas`);
      if (!res.ok) {
        throw new Error(`Failed to fetch personas: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const personas = data as Persona[];
      // Mark them as coordinator scope
      return personas.map(p => ({ ...p, scope: 'coordinator' as const }));
    },

    async fetchSkills(): Promise<Skill[]> {
      const res = await cfetch(`${baseUrl}/skills`);
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
      try {
        const res = await cfetch(
          `${baseUrl}/beacons/${config.beaconId}/sessions`,
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
      try {
        const disconnectedAt = Date.now();
        const durationMs = disconnectedAt - connectedAt;
        const res = await cfetch(
          `${baseUrl}/beacons/${config.beaconId}/sessions/${agentId}`,
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
      try {
        const res = await cfetch(`${baseUrl}/agents/location`, {
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
      try {
        const res = await cfetch(
          `${baseUrl}/agents/location/${agentId}/heartbeat`,
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
      try {
        const res = await cfetch(`${baseUrl}/agents/location/${agentId}`, {
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
      try {
        const res = await cfetch(`${baseUrl}/messages/relay`, {
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
      try {
        const res = await cfetch(`${baseUrl}/personas`, {
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
      try {
        const res = await cfetch(`${baseUrl}/skills`, {
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
      try {
        const res = await cfetch(`${baseUrl}/personas/${id}`, {
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
      try {
        const res = await cfetch(`${baseUrl}/skills/${id}`, {
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
      try {
        const res = await cfetch(`${baseUrl}/sync/knowledge/push`, {
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
      try {
        let url = `${baseUrl}/sync/knowledge/pull`;
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
      try {
        let url = `${baseUrl}/knowledge/search?q=${encodeURIComponent(query)}`;
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
      try {
        const res = await cfetch(`${baseUrl}/sync/sessions/register`, {
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

    async endSwarmSession(sessionId: string): Promise<void> {
      try {
        const res = await cfetch(`${baseUrl}/sync/sessions/${sessionId}`, {
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
      try {
        const res = await cfetch(`${baseUrl}/sync/events/push`, {
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
  };
}
