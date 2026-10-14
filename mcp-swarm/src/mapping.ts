/**
 * The swarm capability catalog for the reference extension.
 *
 * Each capability is declared once (name, description, param schema) and
 * surfaced two ways from that single source of truth: as an MCP tool (this
 * package) and as a coordinator-proxied API action / injected agent tool. The
 * coordinator serves the REST route; here we only translate a capability call
 * into the coordinator REST request it maps onto.
 */

import type { DroneExtensionCapability } from 'drone-core';

export interface CapabilityMapping {
  capability: DroneExtensionCapability;
  method: 'GET' | 'POST';
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
    path: params => `/api/agents/location${query({ beaconId: params.beaconId })}`,
  },
];

/** The capability catalog declared in the extension manifest. */
export const SWARM_CAPABILITIES: DroneExtensionCapability[] =
  CAPABILITY_MAPPINGS.map(m => m.capability);

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
