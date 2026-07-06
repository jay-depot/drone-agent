/**
 * Heartbeat and shutdown for the swarm plugin.
 */

import type { SwarmContext } from './context.js';
import { flushEventBuffer } from './hooks.js';
import { BeaconConfigInjector } from './config.js';
import type { DroneConfigCapability } from 'drone-core';

/**
 * Send a heartbeat to the beacon.
 */
async function heartbeat(ctx: SwarmContext): Promise<void> {
  try {
    await fetch(`${ctx.baseUrl}/agents/${ctx.sessionId}/heartbeat`, {
      method: 'POST',
    });
  } catch {
    // Silently ignore heartbeat failures
  }
}

/**
 * Start the heartbeat interval.
 */
export function startHeartbeat(ctx: SwarmContext): NodeJS.Timeout {
  return setInterval(() => heartbeat(ctx), 30000);
}

/**
 * Register the shutdown hook.
 */
export function registerShutdown(
  ctx: SwarmContext,
  heartbeatInterval: NodeJS.Timeout,
  beaconConfigInjector: BeaconConfigInjector | null,
  configCap: DroneConfigCapability | undefined
): void {
  ctx.registration.hooks.onShutdown(async () => {
    ctx.shuttingDown = true;
    clearInterval(heartbeatInterval);
    if (ctx.ws) ctx.ws.close();
    await flushEventBuffer(ctx);
    if (beaconConfigInjector && configCap) {
      configCap.unregisterInjector(beaconConfigInjector.id);
    }
    // End swarm session on coordinator
    try {
      await fetch(`${ctx.baseUrl}/sync/sessions/${ctx.sessionId}`, {
        method: 'DELETE',
      });
    } catch {
      // Silently ignore cleanup failures
    }
    try {
      await fetch(`${ctx.baseUrl}/agents/${ctx.sessionId}`, {
        method: 'DELETE',
      });
    } catch {
      // Silently ignore cleanup failures
    }
  });
}
