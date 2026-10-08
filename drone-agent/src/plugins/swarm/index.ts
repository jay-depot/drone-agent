import type { DebugFlagRegistry } from 'drone-core';
/**
 * Swarm plugin — connects to a drone-beacon for swarm-wide personas,
 * skills, messaging, wiki, and coordinator integration.
 *
 * This is the barrel file that wires together all sub-modules.
 */

import type {
  DroneConversationEvent,
  DroneContextWindowInfo,
  DroneLlmCapability,
  DronePlugin,
  DronePersonaCapability,
  DroneSessionImportCapability,
  DroneSkillsCapability,
  DroneSlashCommandSessionManager,
  DroneToolDefinition,
  DroneSwarmCapability,
} from 'drone-core';
import { runSessionImport, type SessionImportDeps } from './session-import.js';
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
import {
  createTrustCoordinatorCommand,
  surfacePendingCoordinatorTrust,
} from './tools-coordinator-trust.js';
import { createSwarmSessionCommand } from './session-command.js';
import { registerHooks } from './hooks.js';
import { SwarmMemoryRetriever } from './memory-retrieval.js';
import { ConversationWindowTracker } from './memory-window.js';
import { createSwarmMemoryFragment } from './memory-fragment.js';
import { createSwarmMemoryCommand } from './slash-swarm-memory.js';
import { startHeartbeat, registerShutdown } from './heartbeat.js';
import { startSwarmInfoRefresh } from './swarm-info.js';
import { createSwarmStatusFragment } from './status-fragment.js';
import { createSwarmIdentityFragment } from './identity-fragment.js';

export type { SwarmConfig } from './config.js';

/**
 * Optional host-provided dependencies for the swarm plugin. When
 * `resolveContextWindow` is not provided, `/swarm-session import` falls back
 * to the configured `session.contextWindowTokens`.
 */
export type SwarmPluginDeps = {
  resolveContextWindow?: () => Promise<DroneContextWindowInfo>;
  /** Session manager for the startup `--swarm.session-import` path. */
  sessionManager?: DroneSlashCommandSessionManager;
  /** Run engine hooks (invoked between chunks by the startup import). */
  runHooks?: (hookName: 'onAfterToolCall') => Promise<void>;
};

/**
 * Assemble the context-free dependencies `runSessionImport` needs from the
 * swarm plugin's own handles. Shared by the `/swarm-session import` slash
 * command and the `--swarm.session-import` startup capability.
 */
function buildSessionImportDeps(
  registration: import('drone-core').DronePluginRegistration,
  deps: SwarmPluginDeps | undefined,
  baseUrl: string,
  currentSessionId: string,
  config: import('drone-core').DroneSessionImportConfig,
  getContextWindowTokens: () => Promise<number>
): SessionImportDeps {
  return {
    baseUrl,
    llm: registration.request<DroneLlmCapability>('llm'),
    sessionManager: deps?.sessionManager,
    logger: registration.logger,
    config,
    currentSessionId,
    getContextWindowTokens,
    runAfterToolCallHooks: async () => {
      await deps?.runHooks?.('onAfterToolCall');
    },
  };
}

/**
 * The swarm plugin connects to a drone-beacon and provides
 * personas and skills from the beacon's aggregated store.
 * It also implements a push-through mechanism that records
 * all conversation events to the coordinator via the beacon.
 */
export function createSwarmPlugin(
  config: SwarmConfig,
  deps?: SwarmPluginDeps
): DronePlugin {
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
        { id: 'llm', optional: true },
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
      const baseUrl = `${protocol}://${beaconHost}:${beaconPort}`;
      const wsProtocol = beaconUseHttps ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${beaconHost}:${beaconPort}/ws?agentId=${sessionId}`;
      const localAddress = `${beaconHost}:${beaconPort}`;

      registration.logger.info(
        `Connecting to beacon at ${baseUrl} (session: ${sessionId})`
      );

      // Register the agent session with the beacon
      try {
        const regRes = await fetch(`${baseUrl}/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, personaId: null }),
        });
        if (regRes.ok) {
          const regData = (await regRes.json().catch(() => null)) as {
            coordinatorTrust?: {
              fingerprintTrusted: boolean;
              beaconApproved: boolean;
              pendingFingerprint: string | null;
              verificationCode: string | null;
            };
          } | null;
          const trust = regData?.coordinatorTrust;
          if (trust && (!trust.fingerprintTrusted || !trust.beaconApproved)) {
            await surfacePendingCoordinatorTrust(baseUrl, registration);
          }
        }
        registration.logger.info('Registered with beacon');
      } catch (err) {
        registration.logger.error(
          `Failed to register with beacon: ${err}. Swarm features will be disabled.`
        );
        return;
      }

      // Create shared context
      const ctx = createSwarmContext(
        baseUrl,
        sessionId,
        registration,
        wsUrl,
        localAddress
      );

      // Register prompt fragments unconditionally at registration time so
      // render output is stable whether or not the beacon is reachable;
      // render() reads the in-memory store only (no network).
      registration.registerPromptFragment(
        createSwarmStatusFragment(ctx.swarmInfo)
      );
      registration.registerPromptFragment(
        createSwarmIdentityFragment(ctx.fragmentStore)
      );
      registration.registerPromptFragment({
        key: 'fragments.header',
        phase: 'header',
        render: () => Promise.resolve(ctx.fragmentStore.renderHeader()),
      });
      registration.registerPromptFragment({
        key: 'fragments.footer',
        phase: 'footer',
        render: () => Promise.resolve(ctx.fragmentStore.renderFooter()),
      });

      // ── Offer swarm capability ─────────────────────────────────────────
      // The engine's capability registry is ONE SLOT PER PLUGIN ID: a second
      // `offer()` silently clobbers the first. So the swarm plugin offers a
      // single object that carries both the beacon/agent accessors and the
      // session-import entry point (used by the Herdr resume path and the
      // `--swarm.session-import` startup import). `runImport` closes over
      // the config/getter declared below; it only runs after register()
      // returns, so the bindings are initialized by then.
      const swarmCap: DroneSwarmCapability & DroneSessionImportCapability = {
        getBeaconUrl: () => baseUrl,
        getAgentId: () => sessionId,
        runImport: targetSessionId =>
          runSessionImport(
            buildSessionImportDeps(
              registration,
              deps,
              baseUrl,
              sessionId,
              sessionImportConfig,
              getContextWindowTokens
            ),
            targetSessionId
          ),
      };
      registration.offer(swarmCap);
      registration.logger.info('Offered DroneSwarmCapability');

      // ── Swarm memory (wiki) proactive retrieval ──────────────────────
      // Opt-in via swarm.memory.enabled; the retriever stays inert (zero
      // network) until enabled AND the session is not suppressed.
      const memoryConfig = registration.getConfig().swarm.memory ?? {
        enabled: false,
      };
      const runtimeInfo = registration.request<{
        debugFlags?: DebugFlagRegistry;
        emitEvent?: (event: DroneConversationEvent) => void;
        isSubagent?: boolean;
        swarmSpawned?: boolean;
        subagentId?: string | null;
        persona?: string | null;
      }>('runtime');
      const memoryRetriever = new SwarmMemoryRetriever({
        capability: swarmCap,
        config: memoryConfig,
        logger: registration.logger,
        debugFlags: runtimeInfo?.debugFlags,
        emitNotice: content =>
          runtimeInfo?.emitEvent?.({ kind: 'notice', content }),
      });
      const memoryTracker = new ConversationWindowTracker();
      memoryRetriever.setWindowSource(() => memoryTracker.assemble());
      registration.hooks.onConversationEvent(async event => {
        memoryTracker.onEvent(event);
        // Refresh on the user's message so the CURRENT query drives retrieval
        // (`current.userQuery` is populated above). Fire-and-forget: never
        // block the turn; the fragment renders the last cached entries until
        // the refresh lands. The engine already runs this hook with .catch().
        if (event.kind === 'userMessage') {
          void memoryRetriever
            .maybeRefresh(memoryTracker.assemble())
            .catch(() => {});
        }
      });
      registration.registerPromptFragment(
        createSwarmMemoryFragment(memoryRetriever)
      );
      registration.registerSlashCommand(
        createSwarmMemoryCommand(memoryRetriever)
      );

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
          // Synthetic session-start marker for subagents so the readable
          // transcript's ingest agent can see that a session began as a child
          // process. Fired at the top of the session, before any real events.
          if (runtimeInfo?.isSubagent) {
            registration.emitEvent({
              kind: 'sessionStarted',
              subagentId: runtimeInfo.subagentId ?? null,
              personaId: active?.id ?? runtimeInfo.persona ?? null,
            });
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
        beaconConfigInjector = new BeaconConfigInjector(baseUrl, message => {
          registration.logger.warn(message);
        });
        configCap.registerInjector(beaconConfigInjector);
        registration.logger.info('Registered beacon config injector');
      } else {
        registration.logger.warn(
          'config capability not available; beacon config underlay will not work'
        );
      }

      // ── Lifecycle hooks ────────────────────────────────────────────────
      registerHooks(
        ctx,
        configCap,
        beaconConfigInjector,
        runtimeInfo?.swarmSpawned === true
      );

      // ── Coordinator trust (TOFU) ────────────────────────────────────────
      registration.registerSlashCommand(createTrustCoordinatorCommand(baseUrl));

      // ── Session import command ───────────────────────────────────────────
      const resolveContextWindow = deps?.resolveContextWindow;
      const sessionImportConfig = registration.getConfig().swarm
        .sessionImport ?? {
        maxChunks: 5,
        chunkTokenBudgetPercent: 12,
      };
      const getContextWindowTokens = resolveContextWindow
        ? async () => (await resolveContextWindow()).contextWindowTokens
        : async () => registration.getConfig().session.contextWindowTokens;
      registration.registerSlashCommand(
        createSwarmSessionCommand(
          baseUrl,
          sessionId,
          sessionImportConfig,
          getContextWindowTokens
        )
      );

      // ── Tools ───────────────────────────────────────────────────────────
      const toolFactories: Array<() => DroneToolDefinition> = [
        () => createSwarmMessageTool(ctx),
        ...createWikiTools(ctx).map(t => () => t),
        ...createCoordinatorTools(baseUrl).map(t => () => t),
      ];

      for (const factory of toolFactories) {
        const tool = factory();
        registration.registerTool(tool);
      }

      // ── Heartbeat ───────────────────────────────────────────────────────
      const heartbeatInterval = startHeartbeat(ctx);
      const swarmInfoInterval = startSwarmInfoRefresh(
        ctx.swarmInfo,
        baseUrl,
        registration.logger
      );
      registerShutdown(
        ctx,
        heartbeatInterval,
        swarmInfoInterval,
        beaconConfigInjector,
        configCap
      );
    },
  };
}
