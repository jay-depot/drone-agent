import * as wsServer from '../ws-server.js';

/**
 * Beaconside handler for the coordinator's `inject` / `injectRemove` commands.
 * The coordinator resolves the host beacon and forwards the injection; the
 * beacon relays it to the target agent over the agent WebSocket as an
 * `injection` frame. The agent-side `extensions` plugin owns the state.
 */

export interface ExtensionInjectionPayload {
  /** Extension node id that pushed the injection. */
  extensionId: string;
  /** Recipient agent/session id. */
  target: string;
  kind: 'fragment' | 'reminder' | 'tools';
  /** Caller-chosen injection id (present on `inject`, optional on remove). */
  id?: string;
  injectionId?: string;
  content?: string;
  phase?: 'header' | 'footer';
  ttlMs?: number;
  tools?: Array<{ capability: string }>;
}

/** Relay a raw injection frame to the target agent. */
function sendInjection(
  target: string,
  type: 'injection' | 'injectionRemove',
  payload: ExtensionInjectionPayload
): { status: number; body: unknown } {
  if (!target) {
    return { status: 400, body: { error: 'target is required' } };
  }
  if (!wsServer.isAgentConnected(target)) {
    return {
      status: 404,
      body: { error: 'Agent not connected', code: 'AGENT_NOT_CONNECTED' },
    };
  }
  const delivered = wsServer.sendToAgent(target, { type, payload });
  if (!delivered) {
    return { status: 503, body: { error: 'Failed to deliver injection' } };
  }
  return { status: 200, body: { success: true, delivered: true } };
}

/** Handle the coordinator's `inject` command. */
export function handleInject(payload: ExtensionInjectionPayload): {
  status: number;
  body: unknown;
} {
  return sendInjection(payload.target, 'injection', {
    ...payload,
    id: payload.id ?? payload.injectionId,
  });
}

/** Handle the coordinator's `injectRemove` command. */
export function handleInjectRemove(payload: ExtensionInjectionPayload): {
  status: number;
  body: unknown;
} {
  return sendInjection(payload.target, 'injectionRemove', payload);
}
