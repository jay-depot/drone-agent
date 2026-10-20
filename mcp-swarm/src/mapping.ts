/**
 * The swarm capability catalog for the reference extension.
 *
 * Each capability is declared once (name, description, param schema) and
 * surfaced two ways from that single source of truth: as an MCP tool (this
 * package) and as a coordinator-proxied API action / injected agent tool. The
 * coordinator serves the REST route; here we only translate a capability call
 * into the coordinator REST request it maps onto.
 *
 * Capabilities carry an exposure tier. `mcp` capabilities are visible to MCP
 * clients and agent-callable; `ui` capabilities are for the coordinator UI
 * only (they are hidden from `tools/list` and rejected on the agent tool
 * route).
 */

import type { DroneExtensionCapability } from 'drone-core';

export interface CapabilityMapping {
  capability: DroneExtensionCapability;
  method: 'GET' | 'POST';
  exposed: 'mcp' | 'ui';
  /** Build the coordinator path (with query) for a set of params. */
  path: (params: Record<string, unknown>) => string;
}

/**
 * Build a querystring from the params a capability accepts, skipping empty
 * values so the coordinator sees a clean request.
 */
function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const CAPABILITY_MAPPINGS: CapabilityMapping[] = [
  {
    capability: {
      name: 'swarm.session.list',
      description:
        'List swarm agent sessions known to the coordinator. Optionally filter by status or exclude a status.',
      paramSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Only return sessions with this status.',
          },
          exclude: {
            type: 'string',
            description: 'Exclude sessions with this status.',
          },
        },
      },
      responseSchema: { type: 'object' },
    },
    method: 'GET',
    exposed: 'mcp',
    path: params => `/api/sessions${query(params)}`,
  },
  {
    capability: {
      name: 'swarm.wiki.read',
      description:
        'Read a page from the swarm knowledge-base wiki by its id. Optionally scope to beacon or coordinator.',
      paramSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'The wiki page id.' },
          scope: {
            type: 'string',
            enum: ['beacon', 'coordinator'],
            description: 'Optional scope filter.',
          },
        },
        required: ['pageId'],
      },
      responseSchema: { type: 'object' },
    },
    method: 'GET',
    exposed: 'mcp',
    path: params =>
      `/api/wiki/${encodeURIComponent(String(params.pageId ?? ''))}${query({
        scope: params.scope,
      })}`,
  },
  {
    capability: {
      name: 'swarm.agent.list',
      description:
        'List agent locations known to the coordinator, optionally filtered to one beacon.',
      paramSchema: {
        type: 'object',
        properties: {
          beaconId: {
            type: 'string',
            description: 'Only return agents registered to this beacon.',
          },
        },
      },
      responseSchema: { type: 'array' },
    },
    method: 'GET',
    exposed: 'mcp',
    path: params =>
      `/api/agents/location${query({ beaconId: params.beaconId })}`,
  },
];

/**
 * UI-only capabilities: managed by a local handler in this package, never by
 * the coordinator REST mapping. They are declared in the manifest so the
 * coordinator UI can invoke them through the proxied-action route.
 */
export const TOKEN_CAPABILITIES: DroneExtensionCapability[] = [
  {
    name: 'token.list',
    description: 'List the named auth tokens (never the secrets). UI only.',
    paramSchema: { type: 'object', properties: {} },
    responseSchema: { type: 'object' },
    exposed: 'ui',
  },
  {
    name: 'token.create',
    description:
      'Create a named auth token. The plaintext is returned exactly once. UI only.',
    paramSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name for the token.' },
      },
      required: ['name'],
    },
    responseSchema: { type: 'object' },
    exposed: 'ui',
  },
  {
    name: 'token.revoke',
    description: 'Revoke a token by id. UI only.',
    paramSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The token id to revoke.' },
      },
      required: ['id'],
    },
    responseSchema: { type: 'object' },
    exposed: 'ui',
  },
  {
    name: 'token.rename',
    description: 'Rename a token by id. UI only.',
    paramSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The token id to rename.' },
        name: { type: 'string', description: 'The new name.' },
      },
      required: ['id', 'name'],
    },
    responseSchema: { type: 'object' },
    exposed: 'ui',
  },
];

/** The capability catalog declared in the extension manifest. */
export const SWARM_CAPABILITIES: DroneExtensionCapability[] = [
  ...CAPABILITY_MAPPINGS.map(m => m.capability),
  ...TOKEN_CAPABILITIES,
];

/** The capabilities visible to MCP clients (tier `mcp`). */
export function mcpExposedCapabilities(
  capabilities: DroneExtensionCapability[] = SWARM_CAPABILITIES
): DroneExtensionCapability[] {
  return capabilities.filter(cap => cap.exposed !== 'ui');
}

/** Whether a capability is visible to MCP clients. */
export function isMcpExposed(
  name: string,
  capabilities: DroneExtensionCapability[] = SWARM_CAPABILITIES
): boolean {
  const cap = capabilities.find(candidate => candidate.name === name);
  return !!cap && cap.exposed !== 'ui';
}

/** Whether a capability is a UI-only token-management capability. */
export function isTokenCapability(name: string): boolean {
  return TOKEN_CAPABILITIES.some(cap => cap.name === name);
}

/** The MCP tool name for a capability (1:1 — the catalog name IS the tool name). */
export function mcpToolName(capabilityName: string): string {
  return capabilityName;
}

export interface InvokeResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Execute a swarm capability against the coordinator using an
 * mTLS-authenticated fetch. Returns the coordinator's status + parsed body;
 * a transport failure surfaces as `ok:false, status:0`.
 */
export async function executeCapability(
  capabilityName: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
  baseUrl: string
): Promise<InvokeResult> {
  const mapping = CAPABILITY_MAPPINGS.find(
    m => m.capability.name === capabilityName
  );
  if (!mapping) {
    return { ok: false, status: 404, body: { error: 'Unknown capability' } };
  }
  const url = `${baseUrl}${mapping.path(params)}`;
  try {
    const res = await fetchImpl(url, { method: mapping.method });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : 'transport error' },
    };
  }
}
