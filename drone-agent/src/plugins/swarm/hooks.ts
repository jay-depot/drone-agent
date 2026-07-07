/**
 * Lifecycle hooks for the swarm plugin.
 *
 * Handles onPluginsLoaded (reload, register storage engines),
 * onBeforePrompt (correlation IDs), onConversationEvent (buffering),
 * onAfterToolCall (flush), and onSessionClear.
 */

import type {
  DroneConfigCapability,
  DroneInsightStorageEngine,
  DronePrincipleStorageEngine,
  DroneSelfImprovementCapability,
} from 'drone-core';
import type { SwarmContext } from './context.js';
import {
  reloadFromBeacon,
  registerPersonaProviders,
  registerSkillProviders,
} from './providers.js';
import { connectWebSocket } from './websocket.js';
import { BeaconConfigInjector } from './config.js';

/**
 * Generate a UUID v4 string.
 */
export function generateUuid(): string {
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
 * Flush the event buffer to the coordinator.
 */
export async function flushEventBuffer(ctx: SwarmContext): Promise<void> {
  if (ctx.eventBuffer.length === 0) return;
  const batch = ctx.eventBuffer.splice(0);
  try {
    const res = await fetch(`${ctx.baseUrl}/sync/events/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) {
      ctx.registration.logger.warn(
        `Failed to push ${batch.length} events: ${res.status}`
      );
    } else {
      ctx.registration.logger.info(
        `Pushed ${batch.length} events to coordinator`
      );
    }
  } catch (err) {
    ctx.registration.logger.warn(`Failed to push events: ${err}`);
  }
}

/**
 * Register the swarm session with the beacon.
 */
export async function registerSwarmSession(ctx: SwarmContext): Promise<void> {
  try {
    const res = await fetch(`${ctx.baseUrl}/sync/sessions/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: ctx.sessionId,
        personaId: null,
        beaconId: ctx.sessionId,
      }),
    });
    if (!res.ok) {
      ctx.registration.logger.warn(
        `Failed to register swarm session: ${res.status}`
      );
    } else {
      ctx.registration.logger.info(`Registered swarm session ${ctx.sessionId}`);
    }
  } catch (err) {
    ctx.registration.logger.warn(`Failed to register swarm session: ${err}`);
  }
}

/**
 * Register HTTP storage engines for swarm-scoped insights and principles.
 */
function registerStorageEngines(
  ctx: SwarmContext,
  selfImprovementCap: DroneSelfImprovementCapability
): void {
  const { registration, baseUrl } = ctx;

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
      if (!res.ok) throw new Error(`Failed to record insight: ${res.status}`);
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
      if (!res.ok) throw new Error(`Failed to store principle: ${res.status}`);
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
      if (!res.ok) throw new Error(`Failed to list principles: ${res.status}`);
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
}

/**
 * Register all lifecycle hooks on the swarm plugin registration.
 */
export function registerHooks(
  ctx: SwarmContext,
  configCap: DroneConfigCapability | undefined,
  beaconConfigInjector: BeaconConfigInjector | null
): void {
  const { registration } = ctx;

  registration.hooks.onPluginsLoaded(async () => {
    await reloadFromBeacon(ctx);
    await registerSwarmSession(ctx);
    connectWebSocket(ctx);

    // Register HTTP storage engines for swarm-scoped insights and principles
    const selfImprovementCap =
      registration.request<DroneSelfImprovementCapability>('self-improvement');
    if (selfImprovementCap) {
      registerStorageEngines(ctx, selfImprovementCap);
    } else {
      registration.logger.warn(
        'self-improvement capability not available; swarm insight/principle storage will not be registered'
      );
    }
  });

  registration.hooks.onBeforePrompt(async () => {
    ctx.currentCorrelationId = generateUuid();
    registration.logger.info(`New correlationId: ${ctx.currentCorrelationId}`);
  });

  registration.hooks.onConversationEvent(async event => {
    const now = Date.now();
    const evt = {
      id: generateUuid(),
      sessionId: ctx.sessionId,
      correlationId: ctx.currentCorrelationId ?? undefined,
      type: event.kind,
      payload: JSON.stringify(event),
      metadata: JSON.stringify({
        kind: event.kind,
        ...('name' in event ? { name: event.name } : {}),
      }),
      createdAt: now,
    };
    ctx.eventBuffer.push(evt);
  });

  registration.hooks.onAfterToolCall(async () => {
    await flushEventBuffer(ctx);
  });

  registration.hooks.onSessionClear(async () => {
    ctx.currentCorrelationId = null;
    ctx.eventBuffer.length = 0;
  });
}
