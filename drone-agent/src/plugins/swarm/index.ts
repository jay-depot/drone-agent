/**
 * Swarm plugin — connects to a drone-beacon for swarm-wide personas,
 * skills, messaging, wiki, and coordinator integration.
 *
 * This is the barrel file that wires together all sub-modules.
 */

import type {
  DronePlugin,
  DronePersonaCapability,
  DroneSkillsCapability,
  DroneToolDefinition,
  DroneSwarmCapability,
} from 'drone-core';
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

      // ── Offer swarm capability ─────────────────────────────────────────
      const swarmCap: DroneSwarmCapability = {
        getBeaconUrl: () => baseUrl,
        getAgentId: () => sessionId,
      };
      registration.offer(swarmCap);
      registration.logger.info('Offered DroneSwarmCapability');

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

      // Subscribe to persona changes and update swarm session
      if (personaCap) {
        // Listen for persona changes and update the coordinator session
        personaCap.onPersonaChange(async persona => {
          const { updateSwarmSessionPersona } = await import('./hooks.js');
          await updateSwarmSessionPersona(ctx, persona?.id ?? null);
        });

        // Also sync initial persona on session start (in case one is already active)
        registration.hooks.onSessionStart(async () => {
          const active = personaCap.getActivePersona();
          if (active) {
            const { updateSwarmSessionPersona } = await import('./hooks.js');
            await updateSwarmSessionPersona(ctx, active.id);
          }
        });
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

      // ── Tools ───────────────────────────────────────────────────────────
      const toolFactories: Array<() => DroneToolDefinition> = [
        () => createSwarmMessageTool(ctx),
        ...createWikiTools(ctx).map(t => () => t),
        ...createCoordinatorTools(coordinatorUrl).map(t => () => t),
      ];

      for (const factory of toolFactories) {
        const tool = factory();
        registration.registerTool(tool);
      }

      // ── Heartbeat ───────────────────────────────────────────────────────
      const heartbeatInterval = startHeartbeat(ctx);
      registerShutdown(ctx, heartbeatInterval, beaconConfigInjector, configCap);
    },
  };
}

// Default instance for easy configuration
export const swarmPlugin = createSwarmPlugin({});
