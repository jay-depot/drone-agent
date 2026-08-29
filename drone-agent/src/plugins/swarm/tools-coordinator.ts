/**
 * Coordinator spawn and info tool definitions for the swarm plugin.
 *
 * Provides tools to list beacons, list agents, spawn agents, and
 * manage spawns. These hit the **beacon's** `/coordinator/*` proxy routes
 * (the beacon is the sole coordinator-facing trust gate); the agent never
 * talks to the coordinator directly.
 */

import type { DroneToolDefinition } from 'drone-core';
import { firstMissingString } from './string-params.js';

/**
 * Fetch from the beacon's `/coordinator/*` proxy routes.
 */
async function coordinatorFetch(
  baseUrl: string | undefined,
  path: string,
  options?: RequestInit
): Promise<Response> {
  if (!baseUrl) {
    return {
      ok: false,
      json: async () => ({
        success: false,
        error: 'Beacon URL not configured.',
      }),
    } as Response;
  }
  return fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
}

async function handleCoordinatorResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: response.statusText,
    }));
    return JSON.stringify({
      success: false,
      error: `Coordinator proxy returned ${response.status}`,
      details: body,
    });
  }
  const data = await response.json();
  return JSON.stringify({ success: true, ...data });
}

function handleCoordinatorError(err: unknown): string {
  return JSON.stringify({
    success: false,
    error: 'Failed to reach coordinator',
    details: err instanceof Error ? err.message : 'Unknown error',
  });
}

function createSwarmListBeaconsTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_list_beacons',
    description: 'List all beacons registered with the coordinator.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const response = await coordinatorFetch(
          baseUrl,
          '/coordinator/beacons'
        );
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

function createSwarmListAgentsTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_list_agents',
    description:
      'List agent locations across the swarm. Optionally filter by beacon ID.',
    inputSchema: {
      type: 'object',
      properties: {
        beaconId: {
          type: 'string',
          description:
            'Optional beacon ID to filter agents on a specific beacon',
        },
      },
    },
    execute: async params => {
      try {
        const query = params.beaconId
          ? `?beaconId=${encodeURIComponent(params.beaconId as string)}`
          : '';
        const response = await coordinatorFetch(
          baseUrl,
          `/coordinator/agents/location${query}`
        );
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

function createSwarmSpawnTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_spawn',
    description: 'Spawn a new agent on a remote beacon via the coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        targetBeaconId: {
          type: 'string',
          description: 'The ID of the beacon to spawn the agent on',
        },
        personaId: {
          type: 'string',
          description: 'Optional persona ID to assign to the spawned agent',
        },
        task: {
          type: 'string',
          description: 'Optional task description for the spawned agent',
        },
        config: {
          type: 'object',
          description: 'Optional spawn configuration overrides',
          properties: {
            model: {
              type: 'string',
              description: 'LLM model override',
            },
            preamble: {
              type: 'string',
              description: 'System prompt override',
            },
            workingDir: {
              type: 'string',
              description: 'Working directory',
            },
            env: {
              type: 'object',
              description: 'Extra environment variables',
            },
          },
        },
        spawnId: {
          type: 'string',
          description: 'Optional caller-supplied spawn ID for idempotency',
        },
      },
      required: ['targetBeaconId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['targetBeaconId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `swarm_spawn requires a non-empty ${missing}.`,
        });
      }
      try {
        const response = await coordinatorFetch(baseUrl, '/coordinator/spawn', {
          method: 'POST',
          body: JSON.stringify({
            targetBeaconId: params.targetBeaconId,
            personaId: params.personaId || undefined,
            task: params.task || undefined,
            config: params.config || undefined,
            spawnId: params.spawnId || undefined,
          }),
        });
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

function createSwarmGetSpawnTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_get_spawn',
    description: 'Get the status of a spawned agent on a specific beacon.',
    inputSchema: {
      type: 'object',
      properties: {
        beaconId: {
          type: 'string',
          description: 'The ID of the beacon where the agent was spawned',
        },
        spawnId: {
          type: 'string',
          description: 'The spawn ID returned by swarm_spawn',
        },
      },
      required: ['beaconId', 'spawnId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['beaconId', 'spawnId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `swarm_get_spawn requires a non-empty ${missing}.`,
        });
      }
      try {
        const response = await coordinatorFetch(
          baseUrl,
          `/coordinator/spawn/${encodeURIComponent(params.beaconId as string)}/${encodeURIComponent(params.spawnId as string)}`
        );
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

function createSwarmListSpawnsTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_list_spawns',
    description:
      'List all spawns on a specific beacon, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        beaconId: {
          type: 'string',
          description: 'The ID of the beacon to list spawns from',
        },
        status: {
          type: 'string',
          description:
            'Optional status filter: spawning, running, failed, terminated',
        },
      },
      required: ['beaconId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['beaconId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `swarm_list_spawns requires a non-empty ${missing}.`,
        });
      }
      try {
        const query = params.status
          ? `?status=${encodeURIComponent(params.status as string)}`
          : '';
        const response = await coordinatorFetch(
          baseUrl,
          `/coordinator/spawn/${encodeURIComponent(params.beaconId as string)}${query}`
        );
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

function createSwarmTerminateSpawnTool(
  baseUrl: string | undefined
): DroneToolDefinition {
  return {
    name: 'swarm_terminate_spawn',
    description: 'Terminate a spawned agent on a specific beacon.',
    inputSchema: {
      type: 'object',
      properties: {
        beaconId: {
          type: 'string',
          description: 'The ID of the beacon where the agent is running',
        },
        spawnId: {
          type: 'string',
          description: 'The spawn ID of the agent to terminate',
        },
      },
      required: ['beaconId', 'spawnId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['beaconId', 'spawnId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `swarm_terminate_spawn requires a non-empty ${missing}.`,
        });
      }
      try {
        const response = await coordinatorFetch(
          baseUrl,
          `/coordinator/spawn/${encodeURIComponent(params.beaconId as string)}/${encodeURIComponent(params.spawnId as string)}`,
          { method: 'DELETE' }
        );
        return handleCoordinatorResponse(response);
      } catch (err) {
        return handleCoordinatorError(err);
      }
    },
  };
}

/**
 * Create all coordinator tool definitions.
 */
export function createCoordinatorTools(
  baseUrl: string | undefined
): DroneToolDefinition[] {
  return [
    createSwarmListBeaconsTool(baseUrl),
    createSwarmListAgentsTool(baseUrl),
    createSwarmSpawnTool(baseUrl),
    createSwarmGetSpawnTool(baseUrl),
    createSwarmListSpawnsTool(baseUrl),
    createSwarmTerminateSpawnTool(baseUrl),
  ];
}
