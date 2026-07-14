/**
 * Swarm plugin — connects to a drone-beacon for swarm-wide personas,
 * skills, messaging, wiki, and coordinator integration.
 *
 * This is the barrel file that wires together all sub-modules.
 */

import type {
  DronePersonaCapability,
  DronePlugin,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { ToolMountingCache } from 'drone-core';
import type { SwarmConfig } from './config.js';
import {
  DEFAULT_BEACON_HOST,
  DEFAULT_BEACON_PORT,
  BeaconConfigInjector,
} from './config.js';
import { createSwarmContext } from './context.js';
import {
  registerPersonaProviders,
  registerSkillProviders,
} from './providers.js';
import { createSwarmMessageTool } from './tools-message.js';
import { createWikiTools } from './tools-wiki.js';
import { createCoordinatorTools } from './tools-coordinator.js';
import { registerHooks } from './hooks.js';
import { startHeartbeat, registerShutdown } from './heartbeat.js';

export type { SwarmConfig } from './config.js';

const SWARM_TOOL_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  {
    name: 'swarm_message',
    description:
      'Send a message to another agent in the swarm or subscribe to a channel.',
  },
  {
    name: 'wiki_read',
    description: 'Read a wiki page from the swarm knowledge base by ID.',
  },
  {
    name: 'wiki_write',
    description: 'Create or update a wiki page in the swarm knowledge base.',
  },
  {
    name: 'wiki_search',
    description: 'Search wiki pages in the swarm knowledge base.',
  },
  {
    name: 'wiki_list',
    description: 'List all wiki pages in the swarm knowledge base.',
  },
  {
    name: 'wiki_delete',
    description: 'Delete a wiki page from the swarm knowledge base.',
  },
  {
    name: 'wiki_lint',
    description:
      'Run a lint pass on the local wiki to check for broken links, downward links, and orphan pages.',
  },
  {
    name: 'swarm_list_beacons',
    description: 'List all beacons registered with the coordinator.',
  },
  {
    name: 'swarm_list_agents',
    description:
      'List agent locations across the swarm. Optionally filter by beacon ID.',
  },
  {
    name: 'swarm_spawn',
    description: 'Spawn a new agent on a remote beacon via the coordinator.',
  },
  {
    name: 'swarm_get_spawn',
    description: 'Get the status of a spawned agent on a specific beacon.',
  },
  {
    name: 'swarm_list_spawns',
    description:
      'List all spawns on a specific beacon, optionally filtered by status.',
  },
  {
    name: 'swarm_terminate_spawn',
    description: 'Terminate a spawned agent on a specific beacon.',
  },
];

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
      version: '0.2.0',
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
      const wsProtocol = beaconUseHttps ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${beaconHost}:${beaconPort}/ws?agentId=${sessionId}`;

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

      // Create shared context
      const ctx = createSwarmContext(baseUrl, sessionId, registration, wsUrl);

      // ── Persona and skill providers ─────────────────────────────────────
      const personaCap =
        registration.request<DronePersonaCapability>('persona');
      if (personaCap) {
        registerPersonaProviders(ctx, personaCap);
      } else {
        registration.logger.warn(
          'persona broker not available; swarm personas will not be loaded'
        );
      }

      const skillsCap = registration.request<DroneSkillsCapability>('skills');
      if (skillsCap) {
        registerSkillProviders(ctx, skillsCap);
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
      registerHooks(ctx, configCap, beaconConfigInjector);

      // ── Tools (list/mount pattern) ────────────────────────────────────
      const swarmCache = new ToolMountingCache('swarm');

      // Build all tool definitions and add them to the cache
      const toolFactories: Array<() => DroneToolDefinition> = [
        () => createSwarmMessageTool(ctx),
        ...createWikiTools(ctx).map(t => () => t),
        ...createCoordinatorTools(coordinatorUrl).map(t => () => t),
      ];

      for (const factory of toolFactories) {
        const tool = factory();
        swarmCache.addTool(tool.name, tool);
      }

      // ── Meta-tools ────────────────────────────────────────────────────

      registration.registerTool({
        name: 'list_tools',
        description:
          'List all available swarm tools. Tools include: swarm_message, wiki_read, wiki_write, wiki_search, wiki_list, wiki_delete, wiki_lint, swarm_list_beacons, swarm_list_agents, swarm_spawn, swarm_get_spawn, swarm_list_spawns, swarm_terminate_spawn. Mount the ones you need with swarm__mount_tool.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        execute: async () => {
          let tools = SWARM_TOOL_DESCRIPTIONS;
          if (personaCap) {
            const descriptors = tools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: undefined,
              defaultHidden: false,
            }));
            const filtered = personaCap.getFilteredTools(descriptors);
            const filteredNames = new Set(filtered.map(t => t.name));
            tools = tools.filter(t => filteredNames.has(t.name));
          }
          return JSON.stringify({ toolCount: tools.length, tools }, null, 2);
        },
      });

      registration.registerTool({
        name: 'mount_tool',
        description:
          'Mount a specific swarm tool so it becomes available as a native tool. Use swarm__list_tools to see available tools. Once mounted, the tool will appear in your tool list with its full schema.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description:
                'The name of the tool to mount (as shown by swarm__list_tools).',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        execute: async input => {
          if (
            typeof input.tool !== 'string' ||
            input.tool.trim().length === 0
          ) {
            throw new Error(
              'swarm__mount_tool requires a non-empty tool name.'
            );
          }
          const toolName = input.tool.trim();
          const result = swarmCache.mountTool(toolName, registration);
          if (!result) {
            return JSON.stringify(
              {
                success: false,
                error: `Unknown or already mounted tool: ${toolName}. Use swarm__list_tools to see available tools.`,
              },
              null,
              2
            );
          }
          return JSON.stringify(
            {
              success: true,
              tool: toolName,
              description: result.description,
            },
            null,
            2
          );
        },
      });

      registration.registerTool({
        name: 'unmount_tool',
        description:
          'Unmount a previously mounted swarm tool. This removes the tool from your active tool list to reduce clutter.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description:
                'The name of the tool to unmount (as shown by swarm__list_tools).',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        execute: async input => {
          if (
            typeof input.tool !== 'string' ||
            input.tool.trim().length === 0
          ) {
            throw new Error(
              'swarm__unmount_tool requires a non-empty tool name.'
            );
          }
          const toolName = input.tool.trim();
          swarmCache.unmountTool(toolName, registration);
          return JSON.stringify({ success: true, tool: toolName }, null, 2);
        },
      });

      // ── Heartbeat ───────────────────────────────────────────────────────
      const heartbeatInterval = startHeartbeat(ctx);
      registerShutdown(ctx, heartbeatInterval, beaconConfigInjector, configCap);
    },
  };
}

// Default instance for easy configuration
export const swarmPlugin = createSwarmPlugin({});
