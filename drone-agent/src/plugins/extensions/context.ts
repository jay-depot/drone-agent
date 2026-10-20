/**
 * Shared state for the extensions plugin.
 *
 * Bundles the injection store, the swarm capability handle (for the WS
 * dispatch seam), the runtime handles (reminders + notice events), and the
 * registry of injected tools so module functions can read/write shared state
 * without closure capture.
 */

import type {
  DroneConversationEvent,
  DronePluginRegistration,
  DroneSwarmCapability,
} from 'drone-core';
import {
  createExtensionInjectionStore,
  type ExtensionInjectionStore,
} from './injection-store.js';

/** The subset of the `_runtime` capability the extensions plugin consumes. */
export interface ExtensionsRuntime {
  queueSystemReminder?: (content: string) => void;
  emitEvent?: (event: DroneConversationEvent) => void;
  extensionHint?: string;
  isSubagent?: boolean;
  getSessionId?: () => string;
}

/** One injected tool: its owner and the catalog capability it proxies. */
export interface InjectedToolEntry {
  extensionId: string;
  toolName: string;
}

export interface ExtensionsContext {
  registration: DronePluginRegistration;
  swarmCap: DroneSwarmCapability | undefined;
  runtime: ExtensionsRuntime | undefined;
  store: ExtensionInjectionStore;
  /** Canonical tool name (`extensions__<extId>__<tool>`) → its catalog entry. */
  injectedTools: Map<string, InjectedToolEntry>;
  /** Unsubscribe handle for the `injection` WS frame handler, if registered. */
  unsubscribeWs?: () => void;
}

export function createExtensionsContext(
  registration: DronePluginRegistration
): ExtensionsContext {
  return {
    registration,
    swarmCap: registration.request<DroneSwarmCapability>('swarm'),
    runtime: registration.request<ExtensionsRuntime>('runtime'),
    store: createExtensionInjectionStore(),
    injectedTools: new Map(),
  };
}

/** Emit a user-visible `notice` conversation event (best-effort). */
export function emitNotice(ctx: ExtensionsContext, content: string): void {
  ctx.runtime?.emitEvent?.({ kind: 'notice', content });
}
