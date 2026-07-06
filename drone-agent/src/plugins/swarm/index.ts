import type {
  DroneInsightStorageEngine,
  DronePlugin,
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePersonaWriter,
  DronePrincipleStorageEngine,
  DroneSelfImprovementCapability,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillWriter,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { PRECEDENCE_COORDINATOR, PRECEDENCE_SWARM } from 'drone-core';
import { parsePersonaMd } from '../persona/loader.js';

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
  beaconUseHttps?: boolean;
  coordinatorUrl?: string;
  sessionId?: string;
}

/**
 * The swarm plugin connects to a drone-beacon and provides
 * personas and skills from the beacon's aggregated store.
 * It also implements a push-through mechanism that records
 * all conversation events to the coordinator via the beacon.
 */
export function createSwarmPlugin(config: SwarmConfig): DronePlugin {
  return {
    metadata: {
      id: 'swarm',
      name: 'Swarm',
      version: '0.1.0',
      description:
        'Connects to a drone-beacon for swarm-wide personas and skills.',
      defaultEnabled: false,
      dependencies: [
        { id: 'persona' },
        { id: 'config' },
        { id: 'skills', optional: true },
        { id: 'self-improvement', optional: true },
      ],
    },
    register: async registration => {
      // Read user configuration from config.json
      const userSwarmConfig = registration.getConfig().swarm ?? {};
      const beaconHost =
        userSwarmConfig.beaconHost ?? config.beaconHost ?? DEFAULT_BEACON_HOST;
      const beaconPort =
        userSwarmConfig.beaconPort ?? config.beaconPort ?? DEFAULT_BEACON_PORT;
      const beaconUseHttps =
        userSwarmConfig.beaconUseHttps ?? config.beaconUseHttps ?? false;
      const sessionId =
        userSwarmConfig.sessionId ?? config.sessionId ?? `agent-${Date.now()}`;
      const protocol = beaconUseHttps ? 'https' : 'http';
      const coordinatorUrl =
        userSwarmConfig.coordinatorUrl ?? config.coordinatorUrl;
      const baseUrl = `${protocol}://${beaconHost}:${beaconPort}`;

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
          const rawPersonas = (await personasResp.json()) as Array<{
            id: string;
            name: string;
            description: string;
            systemPrompt: string;
            scope: string;
          }>;
          beaconPersonas = new Map();
          coordinatorPersonas = new Map();

          for (const p of rawPersonas) {
            // Parse the .md content to extract all rich fields
            const definition = parsePersonaMd(p.id, p.systemPrompt);
            // Preserve the scope from the DB, not from the .md frontmatter
            definition.scope =
              p.scope === 'coordinator' ? 'coordinator' : 'beacon';

            if (p.scope === 'coordinator') {
              coordinatorPersonas.set(p.id, definition);
            } else {
              beaconPersonas.set(p.id, definition);
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
        // ── Persona writers ────────────────────────────────────────────
        const beaconPersonaWriter: DronePersonaWriter = {
          id: 'swarm-persona-beacon',
          scope: 'beacon',
          label: 'Beacon (swarm-wide, local hub)',
          exists: async (id: string) => {
            try {
              const res = await fetch(`${baseUrl}/personas/${id}`);
              return res.ok;
            } catch {
              return false;
            }
          },
          writePersona: async (id: string, content: string) => {
            const res = await fetch(`${baseUrl}/personas`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                name: id,
                description: '',
                systemPrompt: content,
              }),
            });
            if (!res.ok) {
              throw new Error(
                `Failed to write persona to beacon: ${res.status}`
              );
            }
            return { filePath: `${baseUrl}/personas/${id}` };
          },
        };
        personaCap.registerWriter(beaconPersonaWriter);

        const coordinatorPersonaWriter: DronePersonaWriter = {
          id: 'swarm-persona-coordinator',
          scope: 'coordinator',
          label: 'Coordinator (global swarm hub)',
          exists: async (id: string) => {
            try {
              const res = await fetch(`${baseUrl}/personas/${id}`);
              return res.ok;
            } catch {
              return false;
            }
          },
          writePersona: async (id: string, content: string) => {
            const res = await fetch(`${baseUrl}/personas`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                name: id,
                description: '',
                systemPrompt: content,
                scope: 'coordinator',
              }),
            });
            if (!res.ok) {
              throw new Error(
                `Failed to write persona to coordinator: ${res.status}`
              );
            }
            return { filePath: `${baseUrl}/personas/${id}` };
          },
        };
        personaCap.registerWriter(coordinatorPersonaWriter);
      } else {
        registration.logger.warn(
          'persona broker not available; swarm personas will not be loaded'
        );
      }

      const skillsCap = registration.request<DroneSkillsCapability>('skills');
      if (skillsCap) {
        skillsCap.registerProvider(beaconSkillProvider);
        skillsCap.registerProvider(coordinatorSkillProvider);
        // ── Skill writers ─────────────────────────────────────────────
        const beaconSkillWriter: DroneSkillWriter = {
          id: 'swarm-skill-beacon',
          scope: 'beacon',
          label: 'Beacon (swarm-wide, local hub)',
          exists: async (id: string) => {
            try {
              const res = await fetch(`${baseUrl}/skills/${id}`);
              return res.ok;
            } catch {
              return false;
            }
          },
          writeSkill: async (id: string, content: string) => {
            const res = await fetch(`${baseUrl}/skills`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                name: id,
                description: '',
                trigger: '',
                body: content,
              }),
            });
            if (!res.ok) {
              throw new Error(`Failed to write skill to beacon: ${res.status}`);
            }
            return { filePath: `${baseUrl}/skills/${id}` };
          },
        };
        skillsCap.registerWriter(beaconSkillWriter);

        const coordinatorSkillWriter: DroneSkillWriter = {
          id: 'swarm-skill-coordinator',
          scope: 'coordinator',
          label: 'Coordinator (global swarm hub)',
          exists: async (id: string) => {
            try {
              const res = await fetch(`${baseUrl}/skills/${id}`);
              return res.ok;
            } catch {
              return false;
            }
          },
          writeSkill: async (id: string, content: string) => {
            const res = await fetch(`${baseUrl}/skills`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                name: id,
                description: '',
                trigger: '',
                body: content,
                scope: 'coordinator',
              }),
            });
            if (!res.ok) {
              throw new Error(
                `Failed to write skill to coordinator: ${res.status}`
              );
            }
            return { filePath: `${baseUrl}/skills/${id}` };
          },
        };
        skillsCap.registerWriter(coordinatorSkillWriter);
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
          registration.request<DroneSelfImprovementCapability>(
            'self-improvement'
          );
        if (selfImprovementCap) {
          const beaconInsightEngine: DroneInsightStorageEngine = {
            providerId: 'swarm-insight-beacon',
            recordInsight: async (targetType, targetId, insight) => {
              const res = await fetch(`${baseUrl}/insights`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType,
                  targetId,
                  insight,
                  scope: 'local',
                }),
              });
              if (!res.ok)
                throw new Error(`Failed to record insight: ${res.status}`);
              return { ok: true, entryCount: 1 };
            },
            listInsights: async (targetType, targetId) => {
              const params = new URLSearchParams();
              if (targetType) params.set('targetType', targetType);
              if (targetId) params.set('targetId', targetId);
              const res = await fetch(`${baseUrl}/insights?${params}`);
              if (!res.ok) return [];
              const data = (await res.json()) as any[];
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
              const data = (await res.json()) as any[];
              return data.map((d: any) => ({
                timestamp: d.timestamp,
                insight: d.insight,
              }));
            },
          };

          const beaconPrincipleEngine: DronePrincipleStorageEngine = {
            providerId: 'swarm-principle-beacon',
            storePrinciple: async (targetType, targetId, principle, source) => {
              const res = await fetch(`${baseUrl}/principles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType,
                  targetId,
                  principle,
                  source,
                  scope: 'local',
                }),
              });
              if (!res.ok)
                throw new Error(`Failed to store principle: ${res.status}`);
              return { ok: true, principleCount: 1 };
            },
            listPrinciples: async (targetType, targetId) => {
              const params = new URLSearchParams();
              if (targetType) params.set('targetType', targetType);
              if (targetId) params.set('targetId', targetId);
              const res = await fetch(`${baseUrl}/principles?${params}`);
              if (!res.ok) return [];
              const data = (await res.json()) as any[];
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
              const data = (await res.json()) as any[];
              return data.map((d: any) => ({
                principle: d.principle,
                source: d.source,
                createdAt: d.createdAt,
              }));
            },
            deletePrinciple: async (targetType, targetId, index) => {
              const params = new URLSearchParams({ targetType, targetId });
              const res = await fetch(`${baseUrl}/principles?${params}`);
              if (!res.ok)
                throw new Error(`Failed to list principles: ${res.status}`);
              const data = (await res.json()) as any[];
              if (index >= data.length) {
                throw new Error(`Index ${index} is out of bounds.`);
              }
              const target = data[index];
              const delRes = await fetch(`${baseUrl}/principles/${target.id}`, {
                method: 'DELETE',
              });
              if (!delRes.ok)
                throw new Error(`Failed to delete principle: ${delRes.status}`);
              return { ok: true, remainingCount: data.length - 1 };
            },
          };

          selfImprovementCap.registerInsightEngine(beaconInsightEngine);
          selfImprovementCap.registerPrincipleEngine(beaconPrincipleEngine);
          registration.logger.info(
            'Registered beacon HTTP storage engines for insights and principles'
          );
        } else {
          registration.logger.warn(
            'self-improvement capability not available; swarm insight/principle storage will not be registered'
          );
        }
      });

      registration.hooks.onBeforePrompt(async () => {
        currentCorrelationId = generateUuid();
        registration.logger.info(`New correlationId: ${currentCorrelationId}`);
      });

      registration.hooks.onConversationEvent(async event => {
        const now = Date.now();
        const evt = {
          id: generateUuid(),
          sessionId,
          correlationId: currentCorrelationId ?? undefined,
          type: event.kind,
          payload: JSON.stringify(event),
          metadata: JSON.stringify({
            kind: event.kind,
            ...('name' in event ? { name: event.name } : {}),
          }),
          createdAt: now,
        };
        eventBuffer.push(evt);
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
      const wsProtocol = beaconUseHttps ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${beaconHost}:${beaconPort}/ws?agentId=${sessionId}`;
      let ws: WebSocket | null = null;
      let shuttingDown = false;
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
            if (shuttingDown) {
              registration.logger.info(
                'WebSocket closed during shutdown; skipping reconnect'
              );
              return;
            }
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
            const message = (error as ErrorEvent).message || String(error);
            registration.logger.error(`WebSocket error: ${message}`);
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

      // ── Wiki tools ───────────────────────────────────────────────────────

      const wikiReadTool: DroneToolDefinition = {
        name: 'wiki_read',
        description: 'Read a wiki page from the swarm knowledge base by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              description: 'The page ID to read',
            },
            scope: {
              type: 'string',
              enum: ['beacon', 'coordinator'],
              description: 'Optional scope filter (beacon or coordinator)',
            },
          },
          required: ['pageId'],
        },
        execute: async params => {
          const pageId = params.pageId as string;
          const scope = params.scope as string | undefined;
          let url = `${baseUrl}/wiki/${encodeURIComponent(pageId)}`;
          if (scope) url += `?scope=${scope}`;
          try {
            const res = await fetch(url);
            if (!res.ok) {
              return JSON.stringify({
                success: false,
                error: `Wiki page not found: ${pageId}`,
              });
            }
            return JSON.stringify({ success: true, page: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to read wiki page: ${err}`,
            });
          }
        },
      };

      const wikiWriteTool: DroneToolDefinition = {
        name: 'wiki_write',
        defaultHidden: true,
        description:
          'Create or update a wiki page in the swarm knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              description: 'The page ID (filesystem-safe slug)',
            },
            title: {
              type: 'string',
              description: 'Human-readable title',
            },
            content: {
              type: 'string',
              description: 'Markdown body content',
            },
            scope: {
              type: 'string',
              enum: ['beacon', 'coordinator'],
              description: 'Scope (beacon or coordinator). Default: beacon',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags for categorization',
            },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional session log IDs that contributed to this page',
            },
          },
          required: ['pageId', 'title', 'content'],
        },
        execute: async params => {
          const { pageId, title, content, scope, tags, sources } = params;
          try {
            const res = await fetch(
              `${baseUrl}/wiki/${encodeURIComponent(pageId as string)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title,
                  content,
                  scope: scope || 'beacon',
                  tags: tags || [],
                  sources: sources || [],
                }),
              }
            );
            if (!res.ok) {
              const err = await res.json();
              return JSON.stringify({
                success: false,
                error: err.error || 'Failed to write wiki page',
              });
            }
            return JSON.stringify({ success: true, page: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to write wiki page: ${err}`,
            });
          }
        },
      };

      const wikiSearchTool: DroneToolDefinition = {
        name: 'wiki_search',
        description: 'Search wiki pages in the swarm knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query string',
            },
          },
          required: ['query'],
        },
        execute: async params => {
          const query = params.query as string;
          try {
            const res = await fetch(
              `${baseUrl}/wiki/search?q=${encodeURIComponent(query)}`
            );
            if (!res.ok) {
              return JSON.stringify({ success: false, error: 'Search failed' });
            }
            return JSON.stringify({ success: true, results: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to search wiki: ${err}`,
            });
          }
        },
      };

      const wikiListTool: DroneToolDefinition = {
        name: 'wiki_list',
        description: 'List all wiki pages in the swarm knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            const res = await fetch(`${baseUrl}/wiki`);
            if (!res.ok) {
              return JSON.stringify({
                success: false,
                error: 'Failed to list wiki pages',
              });
            }
            return JSON.stringify({ success: true, pages: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to list wiki pages: ${err}`,
            });
          }
        },
      };

      const wikiDeleteTool: DroneToolDefinition = {
        name: 'wiki_delete',
        defaultHidden: true,
        description: 'Delete a wiki page from the swarm knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              description: 'The page ID to delete',
            },
            scope: {
              type: 'string',
              enum: ['beacon', 'coordinator'],
              description: 'Optional scope filter (beacon or coordinator)',
            },
          },
          required: ['pageId'],
        },
        execute: async params => {
          const pageId = params.pageId as string;
          const scope = params.scope as string | undefined;
          let url = `${baseUrl}/wiki/${encodeURIComponent(pageId)}`;
          if (scope) url += `?scope=${scope}`;
          try {
            const res = await fetch(url, { method: 'DELETE' });
            if (!res.ok) {
              return JSON.stringify({
                success: false,
                error: 'Failed to delete wiki page',
              });
            }
            return JSON.stringify({ success: true, result: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to delete wiki page: ${err}`,
            });
          }
        },
      };

      const wikiLintTool: DroneToolDefinition = {
        name: 'wiki_lint',
        description:
          'Run a lint pass on the local wiki to check for broken links, downward links, and orphan pages.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            const res = await fetch(`${baseUrl}/wiki/lint`, { method: 'POST' });
            if (!res.ok) {
              return JSON.stringify({ success: false, error: 'Lint failed' });
            }
            return JSON.stringify({ success: true, issues: await res.json() });
          } catch (err) {
            return JSON.stringify({
              success: false,
              error: `Failed to lint wiki: ${err}`,
            });
          }
        },
      };

      registration.registerTool(wikiReadTool);
      registration.registerTool(wikiWriteTool);
      registration.registerTool(wikiSearchTool);
      registration.registerTool(wikiListTool);
      registration.registerTool(wikiDeleteTool);
      registration.registerTool(wikiLintTool);

      // ── Coordinator spawn & info tools ──────────────────────────────────

      const coordinatorFetch = async (path: string, options?: RequestInit) => {
        if (!coordinatorUrl) {
          return {
            ok: false,
            json: async () => ({
              success: false,
              error:
                'coordinatorUrl not configured. Set swarm.coordinatorUrl in your config.',
            }),
          } as Response;
        }
        return fetch(`${coordinatorUrl}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });
      };

      const handleCoordinatorResponse = async (response: Response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({
            error: response.statusText,
          }));
          return JSON.stringify({
            success: false,
            error: `Coordinator returned ${response.status}`,
            details: body,
          });
        }
        const data = await response.json();
        return JSON.stringify({ success: true, ...data });
      };

      const handleCoordinatorError = (err: unknown) =>
        JSON.stringify({
          success: false,
          error: 'Failed to reach coordinator',
          details: err instanceof Error ? err.message : 'Unknown error',
        });

      const swarmListBeaconsTool: DroneToolDefinition = {
        name: 'swarm_list_beacons',
        description: 'List all beacons registered with the coordinator.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            const response = await coordinatorFetch('/beacons');
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      const swarmListAgentsTool: DroneToolDefinition = {
        name: 'swarm_list_agents',
        description:
          'List agent locations across the swarm. Optionally filter by beacon ID.',
        inputSchema: {
          type: 'object',
          properties: {
            beaconId: {
              type: 'string',
              description:
                'Optional beacon ID to filter agents on a specific beacon',
            },
          },
        },
        execute: async params => {
          try {
            const query = params.beaconId
              ? `?beaconId=${encodeURIComponent(params.beaconId as string)}`
              : '';
            const response = await coordinatorFetch(`/agents/location${query}`);
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      const swarmSpawnTool: DroneToolDefinition = {
        name: 'swarm_spawn',
        description:
          'Spawn a new agent on a remote beacon via the coordinator.',
        inputSchema: {
          type: 'object',
          properties: {
            targetBeaconId: {
              type: 'string',
              description: 'The ID of the beacon to spawn the agent on',
            },
            personaId: {
              type: 'string',
              description: 'Optional persona ID to assign to the spawned agent',
            },
            task: {
              type: 'string',
              description: 'Optional task description for the spawned agent',
            },
            config: {
              type: 'object',
              description: 'Optional spawn configuration overrides',
              properties: {
                model: {
                  type: 'string',
                  description: 'LLM model override',
                },
                preamble: {
                  type: 'string',
                  description: 'System prompt override',
                },
                workingDir: {
                  type: 'string',
                  description: 'Working directory',
                },
                env: {
                  type: 'object',
                  description: 'Extra environment variables',
                },
              },
            },
            spawnId: {
              type: 'string',
              description: 'Optional caller-supplied spawn ID for idempotency',
            },
          },
          required: ['targetBeaconId'],
        },
        execute: async params => {
          try {
            const response = await coordinatorFetch('/spawn', {
              method: 'POST',
              body: JSON.stringify({
                targetBeaconId: params.targetBeaconId,
                personaId: params.personaId || undefined,
                task: params.task || undefined,
                config: params.config || undefined,
                spawnId: params.spawnId || undefined,
              }),
            });
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      const swarmGetSpawnTool: DroneToolDefinition = {
        name: 'swarm_get_spawn',
        description: 'Get the status of a spawned agent on a specific beacon.',
        inputSchema: {
          type: 'object',
          properties: {
            beaconId: {
              type: 'string',
              description: 'The ID of the beacon where the agent was spawned',
            },
            spawnId: {
              type: 'string',
              description: 'The spawn ID returned by swarm_spawn',
            },
          },
          required: ['beaconId', 'spawnId'],
        },
        execute: async params => {
          try {
            const response = await coordinatorFetch(
              `/spawn/${encodeURIComponent(params.beaconId as string)}/${encodeURIComponent(params.spawnId as string)}`
            );
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      const swarmListSpawnsTool: DroneToolDefinition = {
        name: 'swarm_list_spawns',
        description:
          'List all spawns on a specific beacon, optionally filtered by status.',
        inputSchema: {
          type: 'object',
          properties: {
            beaconId: {
              type: 'string',
              description: 'The ID of the beacon to list spawns from',
            },
            status: {
              type: 'string',
              description:
                'Optional status filter: spawning, running, failed, terminated',
            },
          },
          required: ['beaconId'],
        },
        execute: async params => {
          try {
            const query = params.status
              ? `?status=${encodeURIComponent(params.status as string)}`
              : '';
            const response = await coordinatorFetch(
              `/spawn/${encodeURIComponent(params.beaconId as string)}${query}`
            );
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      const swarmTerminateSpawnTool: DroneToolDefinition = {
        name: 'swarm_terminate_spawn',
        description: 'Terminate a spawned agent on a specific beacon.',
        inputSchema: {
          type: 'object',
          properties: {
            beaconId: {
              type: 'string',
              description: 'The ID of the beacon where the agent is running',
            },
            spawnId: {
              type: 'string',
              description: 'The spawn ID of the agent to terminate',
            },
          },
          required: ['beaconId', 'spawnId'],
        },
        execute: async params => {
          try {
            const response = await coordinatorFetch(
              `/spawn/${encodeURIComponent(params.beaconId as string)}/${encodeURIComponent(params.spawnId as string)}`,
              { method: 'DELETE' }
            );
            return handleCoordinatorResponse(response);
          } catch (err) {
            return handleCoordinatorError(err);
          }
        },
      };

      registration.registerTool(swarmListBeaconsTool);
      registration.registerTool(swarmListAgentsTool);
      registration.registerTool(swarmSpawnTool);
      registration.registerTool(swarmGetSpawnTool);
      registration.registerTool(swarmListSpawnsTool);
      registration.registerTool(swarmTerminateSpawnTool);

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
        shuttingDown = true;
        clearInterval(heartbeatInterval);
        if (ws) ws.close();
        await flushEventBuffer();
        if (beaconConfigInjector && configCap) {
          configCap.unregisterInjector(beaconConfigInjector.id);
        }
        // End swarm session on coordinator
        try {
          await fetch(`${baseUrl}/sync/sessions/${sessionId}`, {
            method: 'DELETE',
          });
        } catch {
          // Silently ignore cleanup failures
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
