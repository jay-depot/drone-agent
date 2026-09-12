import type { SearchIndexer } from '../search-indexer.js';
import type { CoordinatorClient } from '../coordinator-client.js';
import { logger } from '../logger.js';
import * as db from '../db/index.js';
import { pushFragmentSyncToAllConnected } from '../ws-server.js';

// Lazy-initialized fetch wrapper that accepts the coordinator's self-signed TLS cert
let _coordinatorFetch: typeof fetch | undefined;
function coordinatorFetch(url: string, init?: RequestInit): Promise<Response> {
  const client = getCoordinatorClient();
  if (!_coordinatorFetch && client) {
    // Reuse the fetch the coordinator client already configured with the
    // pinned coordinator fingerprint and the beacon's mTLS client identity,
    // so proxied calls authenticate exactly like registerBeacon/outbox do.
    _coordinatorFetch = client.getFetch();
  }
  return (_coordinatorFetch ?? fetch)(url, init);
}

let coordinatorClient: CoordinatorClient | undefined;
let beaconHost = 'localhost';
let beaconPort = 3457;

export function setCoordinatorClient(client: CoordinatorClient | undefined) {
  coordinatorClient = client;
  // Drop the cached coordinator fetch so the next proxied call re-captures
  // it from the (possibly new) client instead of silently reusing a stale
  // pinned identity left over from a previous coordinator connection.
  _coordinatorFetch = undefined;
}

export function getCoordinatorClient(): CoordinatorClient | undefined {
  return coordinatorClient;
}

let searchIndexer: SearchIndexer | undefined;

export function setSearchIndexer(indexer: SearchIndexer | undefined) {
  searchIndexer = indexer;
}

export function getSearchIndexer(): SearchIndexer | undefined {
  return searchIndexer;
}

export function setBeaconAddress(host: string, port: number) {
  beaconHost = host;
  beaconPort = port;
}

export function getBeaconUrl(): string {
  return `http://${beaconHost}:${beaconPort}`;
}

/**
 * Route a coordinator API path onto the coordinator's /api prefix. The
 * coordinator mounts every API route under /api (registerRoutes prefix), so a
 * proxy path must be prefixed — proxying bare /wiki/... previously hit the SPA
 * fallback (index.html 200) instead of the route, which then broke res.json()
 * into a beacon 500. Idempotent for paths that already carry /api.
 */
export function coordinatorApiPath(path: string): string {
  return path.startsWith('/api') ? path : `/api${path}`;
}

/**
 * Shared coordinator proxy used by every proxied route (insights,
 * principles, wiki). Fastify rejects an empty body when the JSON
 * content-type is set (FST_ERR_CTP_EMPTY_JSON_BODY — the same behavior the
 * outbox flusher works around), so the content-type header and the body are
 * sent only together.
 */
async function proxyCall(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const client = getCoordinatorClient();
  if (!client) {
    return null;
  }
  const url = `${client.getBaseUrl()}${coordinatorApiPath(path)}`;
  const res = await coordinatorFetch(url, {
    method,
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

// Proxy insight/principle requests to coordinator
export const proxyToCoordinator = proxyCall;

// Proxy wiki requests to coordinator
export const proxyWikiToCoordinator = proxyCall;

// Exported function for periodic sync (called from index.ts)
export async function triggerCoordinatorSync(): Promise<{
  success: boolean;
  synced?: {
    personas: number;
    skills: number;
    knowledge: number;
    fragments: number;
    configs: number;
  };
  error?: string;
}> {
  const client = getCoordinatorClient();
  if (!client) {
    return { success: false, error: 'Coordinator not configured' };
  }

  try {
    const personas = await client.fetchPersonas();
    for (const p of personas) {
      db.upsertPersonaFromCoordinator(p);
    }
    const skills = await client.fetchSkills();
    for (const s of skills) {
      db.upsertSkillFromCoordinator(s);
    }

    // Sync knowledge from coordinator
    let knowledgeCount = 0;
    try {
      const knowledge = await client.pullKnowledge();
      if (knowledge.length > 0) {
        db.replaceKnowledgeCache(knowledge);
        knowledgeCount = knowledge.length;
      }
    } catch (err) {
      logger.warn(`Knowledge sync failed: ${err}`);
    }

    // Mirror coordinator-scoped fragments wholesale; fan out a resync to
    // connected agents when the merged set changed.
    let fragmentCount = 0;
    try {
      const hashBefore = db.mergedContentHash();
      const fragments = await client.fetchCoordinatorFragments();
      db.replaceCoordinatorFragments(fragments);
      fragmentCount = fragments.length;
      if (db.mergedContentHash() !== hashBefore) {
        pushFragmentSyncToAllConnected();
      }
    } catch (err) {
      logger.warn(`Fragment mirror sync failed: ${err}`);
    }

    // Pull coordinator config entries as the swarm underlay. Stored as
    // scope='swarm'; beacon-local entries keep precedence (Q8).
    let configCount = 0;
    try {
      const configs = await client.getCoordinatorConfig();
      db.replaceSwarmConfig(configs);
      configCount = configs.length;
    } catch (err) {
      logger.warn(`Coordinator config sync failed: ${err}`);
    }

    logger.info(
      `Synced ${personas.length} personas, ${skills.length} skills, ${knowledgeCount} knowledge entries, ${fragmentCount} fragments, and ${configCount} config entries from coordinator`
    );
    return {
      success: true,
      synced: {
        personas: personas.length,
        skills: skills.length,
        knowledge: knowledgeCount,
        fragments: fragmentCount,
        configs: configCount,
      },
    };
  } catch (err) {
    logger.error(err, 'Sync failed');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// Query interfaces
export interface MemoryQuery {
  namespace?: string;
  includeExpired?: string;
}

export interface SpawnQuery {
  status?: string;
}

export interface EventQuery {
  agentId?: string;
  eventType?: string;
  since?: string;
  limit?: string;
}
