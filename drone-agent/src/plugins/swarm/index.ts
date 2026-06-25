import type {
  DronePlugin,
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { PRECEDENCE_COORDINATOR, PRECEDENCE_SWARM } from 'drone-core';
import { randomUUID } from 'crypto';

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
 */
export function createSwarmPlugin(config: SwarmConfig): DronePlugin {
  const beaconHost = config.beaconHost ?? DEFAULT_BEACON_HOST;
  const beaconPort = config.beaconPort ?? DEFAULT_BEACON_PORT;
  const baseUrl = `http://${beaconHost}:${beaconPort}`;
  const sessionId = config.sessionId ?? `agent-${Date.now()}`;

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
        { id: 'skills', optional: true },
      ],
    },
    register: async (registration) => {
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

      // Helper to load all data from beacon
      const reloadFromBeacon = async () => {
        try {
          // Fetch personas
          const personasResp = await fetch(`${baseUrl}/personas`);
          if (!personasResp.ok) {
            throw new Error(`Failed to fetch personas: ${personasResp.status}`);
          }
          const personasData = await personasResp.json() as DronePersonaDefinition[];
          beaconPersonas = new Map();
          coordinatorPersonas = new Map();

          for (const p of personasData) {
            if ((p as any).scope === 'coordinator') {
              coordinatorPersonas.set(p.id, p);
            } else {
              beaconPersonas.set(p.id, p);
            }
          }

          // Fetch skills
          const skillsResp = await fetch(`${baseUrl}/skills`);
          if (!skillsResp.ok) {
            throw new Error(`Failed to fetch skills: ${skillsResp.status}`);
          }
          const skillsData = await skillsResp.json() as DroneSkillDefinition[];
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

      // ── Beacon-level persona provider ─────────────────────────────────
      const beaconPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-beacon',
        precedence: PRECEDENCE_SWARM,
        getPersonas: () => Array.from(beaconPersonas.values()),
        getPersona: (id: string) => beaconPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      // ── Coordinator-level persona provider ─────────────────────────────
      const coordinatorPersonaProvider: DronePersonaProvider = {
        id: 'swarm-persona-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getPersonas: () => Array.from(coordinatorPersonas.values()),
        getPersona: (id: string) => coordinatorPersonas.get(id),
        reloadPersonas: reloadFromBeacon,
      };

      // ── Beacon-level skill provider ────────────────────────────────────
      const beaconSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-beacon',
        precedence: PRECEDENCE_SWARM,
        getSkills: () => Array.from(beaconSkills.values()),
        getSkill: (id: string) => beaconSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      // ── Coordinator-level skill provider ───────────────────────────────
      const coordinatorSkillProvider: DroneSkillProvider = {
        id: 'swarm-skill-coordinator',
        precedence: PRECEDENCE_COORDINATOR,
        getSkills: () => Array.from(coordinatorSkills.values()),
        getSkill: (id: string) => coordinatorSkills.get(id),
        reloadSkills: reloadFromBeacon,
      };

      // Register with persona broker
      const personaCap = registration.request<DronePersonaCapability>('persona');
      if (personaCap) {
        personaCap.registerProvider(beaconPersonaProvider);
        personaCap.registerProvider(coordinatorPersonaProvider);
      } else {
        registration.logger.warn(
          'persona broker not available; swarm personas will not be loaded'
        );
      }

      // Register with skills broker
      const skillsCap = registration.request<DroneSkillsCapability>('skills');
      if (skillsCap) {
        skillsCap.registerProvider(beaconSkillProvider);
        skillsCap.registerProvider(coordinatorSkillProvider);
      } else {
        registration.logger.warn(
          'skills broker not available; swarm skills will not be loaded'
        );
      }

      // Register tool for messaging


      // Initial load
      registration.hooks.onPluginsLoaded(async () => {
        await reloadFromBeacon();
        // Connect WebSocket for messaging
        connectWebSocket();
      });

      // Heartbeat to keep session alive

      // ── WebSocket client for real-time messaging ────────────────────────
      const wsUrl = `ws://${beaconHost}:${beaconPort}/ws?agentId=${sessionId}`;
      let ws: WebSocket | null = null;
      let wsReconnectAttempts = 0;
      const maxReconnectAttempts = 5;
      const messageQueue: Array<{ toAgentId?: string; toChannel?: string; body: string }> = [];

      // Queue incoming messages for the agent
      const pendingMessages: Array<{ id: string; fromAgentId: string; channel: string | null; body: unknown; receivedAt: number }> = [];

      // Connect to WebSocket
      const connectWebSocket = () => {
        try {
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            registration.logger.info('WebSocket connected to beacon');
            wsReconnectAttempts = 0;
            // Send any queued messages
            while (messageQueue.length > 0) {
              const msg = messageQueue.shift();
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', payload: msg }));
              }
            }
          };

          ws.onmessage = (event) => {
            try {
              const wsMsg = JSON.parse(event.data);
              if (wsMsg.type === 'message') {
                // Queue message for agent
                pendingMessages.push(wsMsg.payload);
                registration.logger.info(`Received message from ${wsMsg.payload.fromAgentId}`);
              } else if (wsMsg.type === 'connected') {
                registration.logger.info('WebSocket handshake complete');
              } else if (wsMsg.type === 'ack') {
                registration.logger.info(`Message ${wsMsg.payload.messageId} acknowledged`);
              } else if (wsMsg.type === 'error') {
                registration.logger.error(`WebSocket error: ${wsMsg.payload.message}`);
              }
            } catch (err) {
              registration.logger.error(`Failed to parse WebSocket message: ${err}`);
            }
          };

          ws.onclose = (event) => {
            registration.logger.warn(`WebSocket closed: ${event.code} ${event.reason}`);
            ws = null;
            // Attempt reconnect
            if (wsReconnectAttempts < maxReconnectAttempts) {
              wsReconnectAttempts++;
              const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
              setTimeout(connectWebSocket, delay);
            }
          };

          ws.onerror = (error) => {
            registration.logger.error(`WebSocket error: ${error}`);
          };
        } catch (err) {
          registration.logger.error(`Failed to connect WebSocket: ${err}`);
        }
      };

      // Send a message via WebSocket or queue it
      const sendMessage = (toAgentId: string | undefined, toChannel: string | undefined, body: string) => {
        const payload = { toAgentId, toChannel, body };
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'message', payload }));
        } else {
          messageQueue.push(payload);
        }
      };

      // Subscribe to a channel
      const subscribeToChannel = (channel: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', payload: { channel } }));
        }
      };

      // Unsubscribe from a channel
      const unsubscribeFromChannel = (channel: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'unsubscribe', payload: { channel } }));
        }
      };

      // Get pending messages (for the agent to consume)
      const getPendingMessages = () => {
        const messages = [...pendingMessages];
        pendingMessages.length = 0;
        return messages;
      };

      // ── Swarm messaging tool ───────────────────────────────────────────
      const swarmMessageTool: DroneToolDefinition = {
        name: 'swarm_message',
        description: 'Send a message to another agent in the swarm or subscribe to a channel.',
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
              description: 'Channel name (for subscribe/unsubscribe/send actions)',
            },
            body: {
              type: 'string',
              description: 'Message body (JSON string, for send action)',
            },
          },
          required: ['action'],
        },
        execute: async (params) => {
          const action = (params.action as string) || '';

          switch (action) {
            case 'send': {
              const toAgentId = params.toAgentId as string | undefined;
              const toChannel = params.toChannel as string | undefined;
              const body = params.body as string;
              if (!toAgentId && !toChannel) {
                return JSON.stringify({ success: false, error: 'Must specify toAgentId or toChannel' });
              }
              sendMessage(toAgentId, toChannel, body);
              return JSON.stringify({ success: true, message: 'Message sent' });
            }
            case 'subscribe': {
              const channel = params.toChannel as string;
              if (!channel) {
                return JSON.stringify({ success: false, error: 'Channel name required' });
              }
              subscribeToChannel(channel);
              return JSON.stringify({ success: true, message: `Subscribed to ${channel}` });
            }
            case 'unsubscribe': {
              const channel = params.toChannel as string;
              if (!channel) {
                return JSON.stringify({ success: false, error: 'Channel name required' });
              }
              unsubscribeFromChannel(channel);
              return JSON.stringify({ success: true, message: `Unsubscribed from ${channel}` });
            }
            case 'get_messages': {
              const messages = getPendingMessages();
              return JSON.stringify({ success: true, messages });
            }
            default:
              return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
          }
        },
      };


      // Register the messaging tool
      registration.registerTool(swarmMessageTool);
      const heartbeat = async () => {
        try {
          await fetch(`${baseUrl}/agents/${sessionId}/heartbeat`, {
            method: 'POST',
          });
        } catch {
          // Silently ignore heartbeat failures
        }
      };

      // Heartbeat every 30 seconds
      const heartbeatInterval = setInterval(heartbeat, 30000);

      // Cleanup on shutdown
      registration.hooks.onShutdown(async () => {
        clearInterval(heartbeatInterval);
        if (ws) ws.close();
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