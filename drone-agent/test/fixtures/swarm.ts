/**
 * Swarm Utilities
 *
 * Provides utilities for interacting with the drone swarm components
 * (coordinator, beacon, agent) during integration testing.
 */

import { request } from './http.js';
import type {
  Agent,
  CreatePersonaRequest,
  Message,
  Persona,
  RequestOptions,
} from './index.js';

/**
 * Wait for a service to be available
 */
export async function waitForService(
  url: string,
  maxAttempts: number = 30,
  intervalMs: number = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        return true;
      }
    } catch {
      // Service not available yet
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function getRequiredIntegrationEnv(
  envName: string,
  fallbackUrl: string
): string {
  const configured = process.env[envName]?.trim();
  if (configured) {
    return configured;
  }
  return fallbackUrl;
}

/**
 * Synchronous guard for swarm integration suites. Returns true when the suite
 * must be skipped to avoid touching a user's real local beacon/coordinator:
 * - RUN_INTEGRATION_TESTS is not set (not running under `pnpm test:integration`)
 * - A target resolved to its unsafe `localhost` fallback (env not provided)
 *
 * Use with `describe.skipIf(shouldSkipIntegrationSuite([...]))`.
 */
export function shouldSkipIntegrationSuite(
  targets: Array<{ url: string; fallbackUrl: string }>
): boolean {
  if (process.env.RUN_INTEGRATION_TESTS !== 'true') {
    return true;
  }
  return targets.some(target => target.url === target.fallbackUrl);
}

/**
 * Make an HTTP request with proper defaults
 */
export async function swarmRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await request<T>(url, options);
  return response;
}

// ============ Coordinator API ============

/**
 * Get all agents from coordinator
 */
export async function getCoordinatorAgents(
  coordinatorUrl: string
): Promise<Agent[]> {
  return swarmRequest<Agent[]>(coordinatorUrl, '/agents');
}

/**
 * Get a specific agent from coordinator
 */
export async function getCoordinatorAgent(
  coordinatorUrl: string,
  agentId: string
): Promise<Agent | null> {
  try {
    return await swarmRequest<Agent>(coordinatorUrl, `/agents/${agentId}`);
  } catch {
    return null;
  }
}

/**
 * Register an agent with the coordinator
 */
export async function registerAgent(
  coordinatorUrl: string,
  agentId: string,
  capabilities: string[] = []
): Promise<void> {
  await swarmRequest(coordinatorUrl, `/agents/${agentId}`, {
    method: 'PUT',
    body: { capabilities },
  });
}

/**
 * Unregister an agent from the coordinator
 */
export async function unregisterAgent(
  coordinatorUrl: string,
  agentId: string
): Promise<void> {
  await swarmRequest(coordinatorUrl, `/agents/${agentId}`, {
    method: 'DELETE',
  });
}

// ============ Beacon API ============

/**
 * Get all agents from beacon
 */
export async function getBeaconAgents(beaconUrl: string): Promise<Agent[]> {
  return swarmRequest<Agent[]>(beaconUrl, '/agents');
}

/**
 * Get a specific agent from beacon
 */
export async function getBeaconAgent(
  beaconUrl: string,
  agentId: string
): Promise<Agent | null> {
  try {
    return await swarmRequest<Agent>(beaconUrl, `/agents/${agentId}`);
  } catch {
    return null;
  }
}

/**
 * Register an agent with the beacon directly (REST fallback for tests that
 * need more than the dummy-agent container, e.g. inter-agent messaging).
 */
export async function registerBeaconAgent(
  beaconUrl: string,
  agentId: string,
  personaId: string | null = null
): Promise<Agent> {
  return swarmRequest<Agent>(beaconUrl, '/agents', {
    method: 'POST',
    body: { id: agentId, personaId },
  });
}

/**
 * Get all personas from beacon
 */
export async function getBeaconPersonas(beaconUrl: string): Promise<Persona[]> {
  return swarmRequest<Persona[]>(beaconUrl, '/personas');
}

/**
 * Get a specific persona from beacon
 */
export async function getBeaconPersona(
  beaconUrl: string,
  personaId: string
): Promise<Persona | null> {
  try {
    return await swarmRequest<Persona>(beaconUrl, `/personas/${personaId}`);
  } catch {
    return null;
  }
}

/**
 * Create a persona in beacon
 */
export async function createBeaconPersona(
  beaconUrl: string,
  persona: CreatePersonaRequest
): Promise<Persona> {
  return swarmRequest<Persona>(beaconUrl, '/personas', {
    method: 'POST',
    body: persona,
  });
}

/**
 * Delete a persona from beacon
 */
export async function deleteBeaconPersona(
  beaconUrl: string,
  personaId: string
): Promise<void> {
  await swarmRequest(beaconUrl, `/personas/${personaId}`, {
    method: 'DELETE',
  });
}

/**
 * Get all skills from beacon
 */
export async function getBeaconSkills(
  beaconUrl: string
): Promise<{ id: string; name: string; description: string }[]> {
  return swarmRequest(beaconUrl, '/skills');
}

/**
 * Get messages for an agent
 */
export async function getBeaconMessages(
  beaconUrl: string,
  agentId: string
): Promise<Message[]> {
  return swarmRequest<Message[]>(
    beaconUrl,
    `/messages?agentId=${encodeURIComponent(agentId)}`
  );
}

/**
 * Send a message to an agent
 */
export async function sendBeaconMessage(
  beaconUrl: string,
  fromAgentId: string,
  toAgentId: string,
  body: object
): Promise<Message> {
  return swarmRequest<Message>(beaconUrl, `/messages`, {
    method: 'POST',
    body: {
      fromAgentId,
      toAgentId,
      body: JSON.stringify(body),
    },
  });
}

/**
 * Send a channel message
 */
export async function sendChannelMessage(
  beaconUrl: string,
  fromAgentId: string,
  channel: string,
  body: object
): Promise<Message> {
  return swarmRequest<Message>(beaconUrl, `/channels/${channel}/messages`, {
    method: 'POST',
    body: {
      fromAgentId,
      body: JSON.stringify(body),
    },
  });
}

/**
 * Join a channel
 */
export async function joinChannel(
  beaconUrl: string,
  agentId: string,
  channel: string
): Promise<void> {
  await swarmRequest(beaconUrl, `/agents/${agentId}/channels/${channel}`, {
    method: 'PUT',
  });
}

/**
 * Leave a channel
 */
export async function leaveChannel(
  beaconUrl: string,
  agentId: string,
  channel: string
): Promise<void> {
  await swarmRequest(beaconUrl, `/agents/${agentId}/channels/${channel}`, {
    method: 'DELETE',
  });
}

// ============ Agent API ============

/**
 * Get agent status
 */
export async function getAgentStatus(
  agentUrl: string
): Promise<{ status: string; persona?: string }> {
  return swarmRequest(agentUrl, '/status');
}

/**
 * Get agent capabilities
 */
export async function getAgentCapabilities(
  agentUrl: string
): Promise<string[]> {
  return swarmRequest(agentUrl, '/capabilities');
}

/**
 * Get available tools from agent
 */
export async function getAgentTools(
  agentUrl: string
): Promise<{ name: string; description: string }[]> {
  return swarmRequest(agentUrl, '/tools');
}

/**
 * Send a task to the agent
 */
export async function sendAgentTask(
  agentUrl: string,
  task: string
): Promise<{ taskId: string }> {
  return swarmRequest(agentUrl, '/task', {
    method: 'POST',
    body: { task },
  });
}

/**
 * Get agent task result
 */
export async function getAgentTaskResult(
  agentUrl: string,
  taskId: string
): Promise<{ status: string; result?: string; error?: string }> {
  return swarmRequest(agentUrl, `/task/${taskId}`);
}

// ============ Spawn API ============

/**
 * Spawn a new agent via beacon
 */
export async function spawnAgent(
  beaconUrl: string,
  options: {
    persona?: string;
    task?: string;
    capabilities?: string[];
  } = {}
): Promise<{ agentId: string }> {
  return swarmRequest(beaconUrl, '/spawn', {
    method: 'POST',
    body: options,
  });
}

/**
 * Terminate a spawned agent
 */
export async function terminateAgent(
  beaconUrl: string,
  agentId: string
): Promise<void> {
  await swarmRequest(beaconUrl, `/spawn/${agentId}`, {
    method: 'DELETE',
  });
}

// ============ Coordinator Sync API ============

/**
 * Push a persona to coordinator
 */
export async function pushPersonaToCoordinator(
  coordinatorUrl: string,
  persona: CreatePersonaRequest
): Promise<void> {
  await swarmRequest(coordinatorUrl, `/api/personas`, {
    method: 'POST',
    body: persona,
  });
}

/**
 * Get personas from coordinator
 */
export async function getCoordinatorPersonas(
  beaconUrl: string
): Promise<Persona[]> {
  // Read through the beacon's coordinator proxy: the coordinator's API is
  // mTLS-gated and only the beacon holds client credentials.
  return swarmRequest<Persona[]>(beaconUrl, '/coordinator/personas');
}

/**
 * Push a skill to coordinator
 */
export async function pushSkillToCoordinator(
  coordinatorUrl: string,
  skill: {
    id: string;
    name: string;
    description: string;
    trigger: string;
    body: string;
  }
): Promise<void> {
  await swarmRequest(coordinatorUrl, `/api/skills`, {
    method: 'POST',
    body: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      body: skill.body,
    },
  });
}

/**
 * Get skills from coordinator
 */
export async function getCoordinatorSkills(
  beaconUrl: string
): Promise<{ id: string; name: string }[]> {
  // Read through the beacon's coordinator proxy: the coordinator's API is
  // mTLS-gated and only the beacon holds client credentials.
  return swarmRequest(beaconUrl, '/coordinator/skills');
}
