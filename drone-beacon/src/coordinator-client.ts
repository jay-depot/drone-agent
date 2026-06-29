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

export function createCoordinatorClient(
  config: CoordinatorConfig,
  options: CoordinatorClientOptions
): CoordinatorClient {
  const protocol = options.useHttps ? 'https' : 'http';
  const baseUrl = `${protocol}://${config.host}:${config.port}`;

  return {
    async registerBeacon(
      identity: BeaconIdentity,
      tlsFingerprint: string
    ): Promise<{
      status: 'pending' | 'approved' | 'rejected';
      approvalToken?: string;
    }> {
      logger.info(`Registering beacon with coordinator at ${baseUrl}`);

      const res = await fetch(`${baseUrl}/beacons`, {
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
        const res = await fetch(`${baseUrl}/beacons/trust/${config.beaconId}`);
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
        const res = await fetch(
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
      const res = await fetch(`${baseUrl}/personas`);
      if (!res.ok) {
        throw new Error(`Failed to fetch personas: ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const personas = data as Persona[];
      // Mark them as coordinator scope
      return personas.map(p => ({ ...p, scope: 'coordinator' as const }));
    },

    async fetchSkills(): Promise<Skill[]> {
      const res = await fetch(`${baseUrl}/skills`);
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
        const res = await fetch(
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
        const res = await fetch(
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
        const res = await fetch(`${baseUrl}/agents/location`, {
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
        const res = await fetch(
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
        const res = await fetch(`${baseUrl}/agents/location/${agentId}`, {
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
        const res = await fetch(`${baseUrl}/messages/relay`, {
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
        const res = await fetch(`${baseUrl}/personas`, {
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
        const res = await fetch(`${baseUrl}/skills`, {
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
        const res = await fetch(`${baseUrl}/personas/${id}`, {
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
        const res = await fetch(`${baseUrl}/skills/${id}`, {
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
        const res = await fetch(`${baseUrl}/sync/knowledge/push`, {
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
        const res = await fetch(url);
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
        const res = await fetch(url);
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
        const res = await fetch(`${baseUrl}/sync/sessions/register`, {
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
        const res = await fetch(`${baseUrl}/sync/events/push`, {
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
