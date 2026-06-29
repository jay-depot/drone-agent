import type {
  DroneInsightStorageEngine,
  DronePlugin,
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePrincipleStorageEngine,
  DroneSelfImprovementCapability,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { PRECEDENCE_COORDINATOR, PRECEDENCE_SWARM } from 'drone-core';

/**
 * Generate a UUID v4 string.
 */
function generateUuid(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  // Set version 4 bits
  array[6] = (array[6] & 0x0f) | 0x40;
  // Set variant bits
  array[8] = (array[8] & 0x3f) | 0x80;
  const hex = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * BeaconConfigInjector fetches config from the beacon and provides it as an underlay.
 */
class BeaconConfigInjector {
  id = 'beacon';
  precedence = 75; // runs after coordinator (50), before agent local (100)

  private baseUrl: string;
  private cachedConfig: Record<string, unknown> = {};

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async inject(): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${this.baseUrl}/config`);
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.status}`);
      }
      const entries = (await response.json()) as Array<{
        key: string;
        value: string;
      }>;

      // Parse JSON values and cache
      this.cachedConfig = {};
      for (const entry of entries) {
        this.cachedConfig[entry.key] = JSON.parse(entry.value);
      }

      return this.cachedConfig;
    } catch (error) {
      // On failure, return cached config if available
      return this.cachedConfig;
    }
  }
}

const DEFAULT_BEACON_HOST = 'localhost';
const DEFAULT_BEACON_PORT = 3457;

/**
 * Configuration for the swarm plugin.
 */
export interface SwarmConfig {
  beaconHost?: string;
  beaconPort?: number;
  sessionId?: string;
}

/**
 * The swarm plugin connects to a drone-beacon and provides
 * personas and skills from the beacon's aggregated store.
 * It also implements a push-through mechanism that records
 * all conversation events to the coordinator via the beacon.
 */
export function createSwarmPlugin(config: SwarmConfig): DronePlugin {
  const beaconHost = config.beaconHost ?? DEFAULT_BEACON_HOST;
  const beaconPort = config.beaconPort ?? DEFAULT_BEACON_PORT;
  const baseUrl = `https://${beaconHost}:${beaconPort}`;
  const sessionId = config.sessionId ?? `agent-${Date.now()}`;

  return {
    metadata: {
      id: 'swarm',
      name: 'Swarm',
      version: '0.1.0',
      description:
        'Connects to a drone-beacon for swarm-wide personas and skills.',
      defaultEnabled: false,
      dependencies: [{ id: 'persona' }, { id: 'skills', optional: true }, { id: 'self-improvement', optional: true }],
    },
    register: async registration => {
      registration.logger.info(
        `Connecting to beacon at ${baseUrl} (session: ${sessionId})`
      );

      // Register the agent session with the beacon
      try {
        await fetch(`${baseUrl}/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, personaId: null }),
        });
        registration.logger.info('Registered with beacon');
      } catch (err) {
        registration.logger.error(
          `Failed to register with beacon: ${err}. Swarm features will be disabled.`
        );
        return;
      }

      // Keep track of loaded data
      let beaconPersonas = new Map<string, DronePersonaDefinition>();
      let coordinatorPersonas = new Map<string, DronePersonaDefinition>();
      let beaconSkills = new Map<string, DroneSkillDefinition>();
      let coordinatorSkills = new Map<string, DroneSkillDefinition>();

      // ── Push-through session storage state ──────────────────────────────
      let currentCorrelationId: string | null = null;
      let pushedEventCount = 0;
      const eventBuffer: Array<{
        id: string;
        sessionId: string;
        correlationId?: string;
        type: string;
        payload?: string;
        metadata?: string;
        createdAt: number;
      }> = [];

      const flushEventBuffer = async () => {
        if (eventBuffer.length === 0) return;
        const batch = eventBuffer.splice(0);
        try {
          const res = await fetch(`${baseUrl}/sync/events/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
          });
          if (!res.ok) {
            registration.logger.warn(
              `Failed to push ${batch.length} events: ${res.status}`
            );
          } else {
            registration.logger.info(
              `Pushed ${batch.length} events to coordinator`
            );
          }
        } catch (err) {
          registration.logger.warn(`Failed to push events: ${err}`);
        }
      };

      const registerSwarmSession = async () => {
        try {
          const res = await fetch(`${baseUrl}/sync/sessions/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: sessionId,
              personaId: null,
              beaconId: sessionId,
            }),
          });
          if (!res.ok) {
            registration.logger.warn(
              `Failed to register swarm session: ${res.status}`
            );
          } else {
            registration.logger.info(`Registered swarm session ${sessionId}`);
          }
        } catch (err) {
          registration.logger.warn(`Failed to register swarm session: ${err}`);
        }
      };

      const reloadFromBeacon = async () => {
        try {
          const personasResp = await fetch(`${baseUrl}/personas`);
          if (!personasResp.ok) {
            throw new Error(`Failed to fetch personas: ${personasResp.status}`);
          }
          const personasData =
            (await personasResp.json()) as DronePersonaDefinition[];
          beaconPersonas = new Map();
          coordinatorPersonas = new Map();

          for (const p of personasData) {
            if ((p as any).scope === 'coordinator') {
              coordinatorPersonas.set(p.id, p);
            } else {
              beaconPersonas.set(p.id, p);
            }
          }

          const skillsResp = await fetch(`${baseUrl}/skills`);
          if (!skillsResp.ok) {
            throw new Error(`Failed to fetch skills: ${skillsResp.status}`);
          }
          const skillsData =
            (await skillsResp.json()) as DroneSkillDefinition[];
          beaconSkills = new Map();
          coordinatorSkills = new Map();

          for (const s of skillsData) {
            if ((s as any).scope === 'coordinator') {
              coordinatorSkills.set(s.id, s);
            } else {
              beaconSkills.set(s.id, s);
            }
          }

          registration.logger.info(
            `Loaded ${beaconPersonas.size} beacon + ${coordinatorPersonas.size} coordinator personas`
          );
          registration.logger.info(
            `Loaded ${beaconSkills.size} beacon + ${coordinatorSkills.size} coordinator skills`
          );
        } catch (err) {
          registration.logger.error(`Failed to reload from beacon: ${err}`);
        }
      };

      // ── Persona and skill providers ─────────────────────────────────────
      const beaconPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-beacon',
        precedence: PRECEDENCE_SWARM,
        getPersonas: () => Array.from(beaconPersonas.values()),
        getPersona: (id: string) => beaconPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      const coordinatorPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getPersonas: () => Array.from(coordinatorPersonas.values()),
        getPersona: (id: string) => coordinatorPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      const beaconSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-beacon',
        precedence: PRECEDENCE_SWARM,
        getSkills: () => Array.from(beaconSkills.values()),
        getSkill: (id: string) => beaconSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      const coordinatorSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getSkills: () => Array.from(coordinatorSkills.values()),
        getSkill: (id: string) => coordinatorSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      const personaCap =
        registration.request<DronePersonaCapability>('persona');
      if (personaCap) {
        personaCap.registerProvider(beaconPersonaProvider);
        personaCap.registerProvider(coordinatorPersonaProvider);
      } else {
        registration.logger.warn(
          'persona broker not available; swarm personas will not be loaded'
        );
      }

      const skillsCap = registration.request<DroneSkillsCapability>('skills');
      if (skillsCap) {
        skillsCap.registerProvider(beaconSkillProvider);
        skillsCap.registerProvider(coordinatorSkillProvider);
      } else {
        registration.logger.warn(
          'skills broker not available; swarm skills will not be loaded'
        );
      }

      // ── Config injector ─────────────────────────────────────────────────
      let beaconConfigInjector: BeaconConfigInjector | null = null;
      const configCap =
        registration.request<import('drone-core').DroneConfigCapability>(
          'config'
        );
      if (configCap) {
        beaconConfigInjector = new BeaconConfigInjector(baseUrl);
        configCap.registerInjector(beaconConfigInjector);
        registration.logger.info('Registered beacon config injector');
      } else {
        registration.logger.warn(
          'config capability not available; beacon config underlay will not work'
        );
      }

      // ── Lifecycle hooks ────────────────────────────────────────────────

      registration.hooks.onPluginsLoaded(async () => {
        await reloadFromBeacon();
        await registerSwarmSession();
        connectWebSocket();

        // Register HTTP storage engines for swarm-scoped insights and principles
        const selfImprovementCap =
          registration.request<DroneSelfImprovementCapability>('self-improvement');
        if (selfImprovementCap) {
          const beaconInsightEngine: DroneInsightStorageEngine = {
            providerId: 'swarm-insight-beacon',
            recordInsight: async (targetType, targetId, insight) => {
              const res = await fetch(`${baseUrl}/insights`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetType, targetId, insight, scope: 'local' }),
              });
              if (!res.ok) throw new Error(`Failed to record insight: ${res.status}`);
              return { ok: true, entryCount: 1 };
            },
            listInsights: async (targetType, targetId) => {
              const params = new URLSearchParams();
              if (targetType) params.set('targetType', targetType);
              if (targetId) params.set('targetId', targetId);
              const res = await fetch(`${baseUrl}/insights?${params}`);
              if (!res.ok) return [];
              const data = await res.json() as any[];
              return data.map((d: any) => ({
                targetType: d.targetType,
                targetId: d.targetId,
                entryCount: 1,
                lastTimestamp: d.timestamp,
              }));
            },
            readInsights: async (targetType, targetId) => {
              const params = new URLSearchParams({ targetType, targetId });
              const res = await fetch(`${baseUrl}/insights?${params}`);
              if (!res.ok) return [];
              const data = await res.json() as any[];
              return data.map((d: any) => ({ timestamp: d.timestamp, insight: d.insight }));
            },
          };

          const beaconPrincipleEngine: DronePrincipleStorageEngine = {
            providerId: 'swarm-principle-beacon',
            storePrinciple: async (targetType, targetId, principle, source) => {
              const res = await fetch(`${baseUrl}/principles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetType, targetId, principle, source, scope: 'local' }),
              });
              if (!res.ok) throw new Error(`Failed to store principle: ${res.status}`);
              return { ok: true, principleCount: 1 };
            },
            listPrinciples: async (targetType, targetId) => {
              const params = new URLSearchParams();
              if (targetType) params.set('targetType', targetType);
              if (targetId) params.set('targetId', targetId);
              const res = await fetch(`${baseUrl}/principles?${params}`);
              if (!res.ok) return [];
              const data = await res.json() as any[];
              return data.map((d: any) => ({
                targetType: d.targetType,
                targetId: d.targetId,
                principleCount: 1,
              }));
            },
            readPrinciples: async (targetType, targetId) => {
              const params = new URLSearchParams({ targetType, targetId });
              const res = await fetch(`${baseUrl}/principles?${params}`);
              if (!res.ok) return [];
              const data = await res.json() as any[];
              return data.map((d: any) => ({
                principle: d.principle,
                source: d.source,
                createdAt: d.createdAt,
              }));
            },
            deletePrinciple: async (targetType, targetId, index) => {
              const params = new URLSearchParams({ targetType, targetId });
              const res = await fetch(`${baseUrl}/principles?${params}`);
              if (!res.ok) throw new Error(`Failed to list principles: ${res.status}`);
              const data = await res.json() as any[];
              if (index >= data.length) {
                throw new Error(`Index ${index} is out of bounds.`);
              }
              const target = data[index];
              const delRes = await fetch(`${baseUrl}/principles/${target.id}`, { method: 'DELETE' });
              if (!delRes.ok) throw new Error(`Failed to delete principle: ${delRes.status}`);
              return { ok: true, remainingCount: data.length - 1 };
            },
          };

          selfImprovementCap.registerInsightEngine(beaconInsightEngine);
          selfImprovementCap.registerPrincipleEngine(beaconPrincipleEngine);
          registration.logger.info('Registered beacon HTTP storage engines for insights and principles');
        } else {
          registration.logger.warn('self-improvement capability not available; swarm insight/principle storage will not be registered');
        }
      });

      registration.hooks.onBeforePrompt(async () => {
        currentCorrelationId = generateUuid();
        registration.logger.info(`New correlationId: ${currentCorrelationId}`);
      });

      registration.hooks.onAfterToolCall(async () => {
        await flushEventBuffer();
      });

      registration.hooks.onSessionClear(async () => {
        currentCorrelationId = null;
        pushedEventCount = 0;
        eventBuffer.length = 0;
      });

      // ── WebSocket client ────────────────────────────────────────────────
      const wsUrl = `wss://${beaconHost}:${beaconPort}/ws?agentId=${sessionId}`;
      let ws: WebSocket | null = null;
      let wsReconnectAttempts = 0;
      const maxReconnectAttempts = 5;
      const messageQueue: Array<{
        toAgentId?: string;
        toChannel?: string;
        body: string;
      }> = [];

      const pendingMessages: Array<{
        id: string;
        fromAgentId: string;
        channel: string | null;
        body: unknown;
        receivedAt: number;
      }> = [];

      const connectWebSocket = () => {
        try {
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            registration.logger.info('WebSocket connected to beacon');
            wsReconnectAttempts = 0;
            while (messageQueue.length > 0) {
              const msg = messageQueue.shift();
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', payload: msg }));
              }
            }
          };

          ws.onmessage = event => {
            try {
              const wsMsg = JSON.parse(event.data);
              if (wsMsg.type === 'message') {
                pendingMessages.push(wsMsg.payload);
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
              registration.logger.error(
                `Failed to parse WebSocket message: ${err}`
              );
            }
          };

          ws.onclose = event => {
            registration.logger.warn(
              `WebSocket closed: ${event.code} ${event.reason}`
            );
            ws = null;
            if (wsReconnectAttempts < maxReconnectAttempts) {
              wsReconnectAttempts++;
              const delay = Math.min(
                1000 * Math.pow(2, wsReconnectAttempts),
                30000
              );
              setTimeout(connectWebSocket, delay);
            }
          };

          ws.onerror = error => {
            registration.logger.error(`WebSocket error: ${error}`);
          };
        } catch (err) {
          registration.logger.error(`Failed to connect WebSocket: ${err}`);
        }
      };

      const sendMessage = (
        toAgentId: string | undefined,
        toChannel: string | undefined,
        body: string
      ) => {
        const payload = { toAgentId, toChannel, body };
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'message', payload }));
        } else {
          messageQueue.push(payload);
        }
      };

      const subscribeToChannel = (channel: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', payload: { channel } }));
        }
      };

      const unsubscribeFromChannel = (channel: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: 'unsubscribe', payload: { channel } })
          );
        }
      };

      const getPendingMessages = () => {
        const messages = [...pendingMessages];
        pendingMessages.length = 0;
        return messages;
      };

      // ── Swarm messaging tool ───────────────────────────────────────────
      const swarmMessageTool: DroneToolDefinition = {
        name: 'swarm_message',
        description:
          'Send a message to another agent in the swarm or subscribe to a channel.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['send', 'subscribe', 'unsubscribe', 'get_messages'],
              description: 'The action to perform',
            },
            toAgentId: {
              type: 'string',
              description: 'Target agent ID (for send action)',
            },
            toChannel: {
              type: 'string',
              description:
                'Channel name (for subscribe/unsubscribe/send actions)',
            },
            body: {
              type: 'string',
              description: 'Message body (JSON string, for send action)',
            },
          },
          required: ['action'],
        },
        execute: async params => {
          const action = (params.action as string) || '';

          switch (action) {
            case 'send': {
              const toAgentId = params.toAgentId as string | undefined;
              const toChannel = params.toChannel as string | undefined;
              const body = params.body as string;
              if (!toAgentId && !toChannel) {
                return JSON.stringify({
                  success: false,
                  error: 'Must specify toAgentId or toChannel',
                });
              }
              sendMessage(toAgentId, toChannel, body);
              return JSON.stringify({ success: true, message: 'Message sent' });
            }
            case 'subscribe': {
              const channel = params.toChannel as string;
              if (!channel) {
                return JSON.stringify({
                  success: false,
                  error: 'Channel name required',
                });
              }
              subscribeToChannel(channel);
              return JSON.stringify({
                success: true,
                message: `Subscribed to ${channel}`,
              });
            }
            case 'unsubscribe': {
              const channel = params.toChannel as string;
              if (!channel) {
                return JSON.stringify({
                  success: false,
                  error: 'Channel name required',
                });
              }
              unsubscribeFromChannel(channel);
              return JSON.stringify({
                success: true,
                message: `Unsubscribed from ${channel}`,
              });
            }
            case 'get_messages': {
              const messages = getPendingMessages();
              return JSON.stringify({ success: true, messages });
            }
            default:
              return JSON.stringify({
                success: false,
                error: `Unknown action: ${action}`,
              });
          }
        },
      };

      registration.registerTool(swarmMessageTool);

      // ── Heartbeat ───────────────────────────────────────────────────────
      const heartbeat = async () => {
        try {
          await fetch(`${baseUrl}/agents/${sessionId}/heartbeat`, {
            method: 'POST',
          });
        } catch {
          // Silently ignore heartbeat failures
        }
      };

      const heartbeatInterval = setInterval(heartbeat, 30000);

      registration.hooks.onShutdown(async () => {
        clearInterval(heartbeatInterval);
        if (ws) ws.close();
        await flushEventBuffer();
        if (beaconConfigInjector && configCap) {
          configCap.unregisterInjector(beaconConfigInjector.id);
        }
        try {
          await fetch(`${baseUrl}/agents/${sessionId}`, {
            method: 'DELETE',
          });
        } catch {
          // Silently ignore cleanup failures
        }
      });
    },
  };
}

// Default instance for easy configuration
export const swarmPlugin = createSwarmPlugin({});
