import type { FastifyInstance } from 'fastify';
import {
  type CoordinatorClient,
  createCoordinatorFetch,
} from '../coordinator-client.js';
import { logger } from '../logger.js';
import * as db from '../db.js';

// Lazy-initialized fetch wrapper that accepts the coordinator's self-signed TLS cert
let _coordinatorFetch: typeof fetch | undefined;
function coordinatorFetch(url: string, init?: RequestInit): Promise<Response> {
  const client = getCoordinatorClient();
  if (!_coordinatorFetch && client) {
    _coordinatorFetch = createCoordinatorFetch(client.getBaseUrl());
  }
  return (_coordinatorFetch ?? fetch)(url, init);
}

let coordinatorClient: CoordinatorClient | undefined;
let beaconHost = 'localhost';
let beaconPort = 3457;

export function setCoordinatorClient(client: CoordinatorClient | undefined) {
  coordinatorClient = client;
}

export function getCoordinatorClient(): CoordinatorClient | undefined {
  return coordinatorClient;
}

export function setBeaconAddress(host: string, port: number) {
  beaconHost = host;
  beaconPort = port;
}

export function getBeaconUrl(): string {
  return `http://${beaconHost}:${beaconPort}`;
}

// Helper to proxy insight/principle requests to coordinator
export async function proxyToCoordinator(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const client = getCoordinatorClient();
  if (!client) {
    return null;
  }
  const url = `${client.getBaseUrl()}${path}`;
  const res = await coordinatorFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

// Helper to proxy wiki requests to coordinator
export async function proxyWikiToCoordinator(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const client = getCoordinatorClient();
  if (!client) {
    return null;
  }
  const url = `${client.getBaseUrl()}${path}`;
  const res = await coordinatorFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

// Exported function for periodic sync (called from index.ts)
export async function triggerCoordinatorSync(): Promise<{
  success: boolean;
  synced?: { personas: number; skills: number; knowledge: number };
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

    logger.info(
      `Synced ${personas.length} personas, ${skills.length} skills, and ${knowledgeCount} knowledge entries from coordinator`
    );
    return {
      success: true,
      synced: {
        personas: personas.length,
        skills: skills.length,
        knowledge: knowledgeCount,
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
