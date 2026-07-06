/**
 * Shared state for the swarm plugin.
 *
 * The factory closure in index.ts creates a SwarmContext that bundles
 * all mutable state (maps, buffers, WebSocket, etc.) so that extracted
 * module functions can access and mutate it without closure capture.
 */

import type {
  DronePersonaDefinition,
  DronePluginRegistration,
  DroneSkillDefinition,
} from 'drone-core';

/** A single buffered conversation event awaiting push to the coordinator. */
export interface BufferedEvent {
  id: string;
  sessionId: string;
  correlationId?: string;
  type: string;
  payload?: string;
  metadata?: string;
  createdAt: number;
}

/** A pending WebSocket message received from another agent. */
export interface PendingMessage {
  id: string;
  fromAgentId: string;
  channel: string | null;
  body: unknown;
  receivedAt: number;
}

/** A queued outbound WebSocket message. */
export interface QueuedMessage {
  toAgentId?: string;
  toChannel?: string;
  body: string;
}

/**
 * All shared mutable state for the swarm plugin.
 *
 * Module functions receive this context and can read/write the
 * shared state without relying on closure capture.
 */
export interface SwarmContext {
  baseUrl: string;
  sessionId: string;
  registration: DronePluginRegistration;
  beaconPersonas: Map<string, DronePersonaDefinition>;
  coordinatorPersonas: Map<string, DronePersonaDefinition>;
  beaconSkills: Map<string, DroneSkillDefinition>;
  coordinatorSkills: Map<string, DroneSkillDefinition>;
  eventBuffer: BufferedEvent[];
  currentCorrelationId: string | null;
  ws: WebSocket | null;
  shuttingDown: boolean;
  wsReconnectAttempts: number;
  maxReconnectAttempts: number;
  messageQueue: QueuedMessage[];
  pendingMessages: PendingMessage[];
  wsUrl: string;
}

/**
 * Create a SwarmContext with default values.
 */
export function createSwarmContext(
  baseUrl: string,
  sessionId: string,
  registration: DronePluginRegistration,
  wsUrl: string
): SwarmContext {
  return {
    baseUrl,
    sessionId,
    registration,
    beaconPersonas: new Map(),
    coordinatorPersonas: new Map(),
    beaconSkills: new Map(),
    coordinatorSkills: new Map(),
    eventBuffer: [],
    currentCorrelationId: null,
    ws: null,
    shuttingDown: false,
    wsReconnectAttempts: 0,
    maxReconnectAttempts: 5,
    messageQueue: [],
    pendingMessages: [],
    wsUrl,
  };
}
