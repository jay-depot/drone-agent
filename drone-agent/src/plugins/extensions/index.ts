/**
 * Extensions plugin — receives injections (prompt fragments, one-shot system
 * reminders, proxied tool selections) from connected swarm extensions and
 * materializes them into the session.
 *
 * An extension is a swarm node that declares a capability manifest. The
 * coordinator forwards its `injection` / `injectRemove` frames to this agent's
 * host beacon, which relays them over the agent WebSocket; the swarm plugin's
 * WS seam routes them here. This plugin has a HARD dependency on `swarm`.
 */

import type { DronePlugin, DroneSwarmCapability } from 'drone-core';
import { createExtensionsContext, type ExtensionsContext } from './context.js';
import {
  createInjectionHeaderFragment,
  createInjectionFooterFragment,
} from './injection-fragment.js';
import {
  handleInjection,
  handleInjectionRemove,
  type InjectionPayload,
} from './injection-handlers.js';
import { reconcileInjectedTools } from './tools.js';
import { createExtensionsCommand } from './command.js';

export const extensionsPlugin: DronePlugin = {
  metadata: {
    id: 'extensions',
    name: 'Extensions',
    version: '0.1.0',
    description:
      'Receives prompt fragments, one-shot reminders, and proxied tool selections from swarm extensions.',
    defaultEnabled: false,
    dependencies: [{ id: 'swarm' }],
  },
  register: async registration => {
    const ctx = createExtensionsContext(registration);

    // Prompt seams: registered after the swarm fragments so injected content
    // is ordered after the built-ins.
    registration.registerPromptFragment(createInjectionHeaderFragment(ctx.store));
    registration.registerPromptFragment(createInjectionFooterFragment(ctx.store));

    registration.registerSlashCommand(createExtensionsCommand(ctx));

    const swarmCap = ctx.swarmCap as DroneSwarmCapability | undefined;
    if (!swarmCap?.registerWsHandler) {
      registration.logger.warn(
        'extensions plugin: swarm capability not available; injections will not be received'
      );
    } else {
      const offInject = swarmCap.registerWsHandler('injection', payload =>
        handleInjection(ctx, payload as InjectionPayload)
      );
      const offRemove = swarmCap.registerWsHandler('injectionRemove', payload =>
        handleInjectionRemove(ctx, payload as InjectionPayload)
      );
      ctx.unsubscribeWs = () => {
        offInject();
        offRemove();
      };
    }

    // A recycled session is a fresh conversation: drop every injection and
    // its materialized tools. The extension receives a fresh `sessionStarted`
    // and re-injects as needed.
    registration.hooks.onSessionRecycle(async () => {
      ctx.store.clearAll();
      reconcileInjectedTools(ctx);
    });

    registration.hooks.onShutdown(async () => {
      ctx.unsubscribeWs?.();
    });
  },
};
