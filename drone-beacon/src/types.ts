// Shared types imported from drone-core
export type {
  Persona,
  Skill,
  CreatePersonaRequest,
  CreateSkillRequest,
} from 'drone-core';

// === Beacon-specific types ===

export interface AgentSession {
  id: string;
  personaId: string | null;
  connectedAt: number;
  lastActivity: number;
}

export interface CoordinatorConfig {
  host: string;
  port: number;
  beaconId: string;
  beaconName: string;
}

export interface RegisterAgentRequest {
  id: string;
  personaId: string | null;
}

// === Memory Types ===

export interface Memory {
  id: string;
  key: string;
  value: string;
  namespace: string;
  ttl: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMemoryRequest {
  key: string;
  value: string;
  namespace?: string;
  ttlSeconds?: number;
}

export interface UpdateMemoryRequest {
  key?: string;
  value?: string;
  ttlSeconds?: number;
}

// === Message Types ===

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | null;
  channel: string | null;
  body: string; // JSON string
  delivered: boolean;
  createdAt: number;
}

export interface CreateMessageRequest {
  toAgentId?: string;
  toChannel?: string;
  body: string; // JSON string
}

// === Spawn Types ===

export interface SpawnConfig {
  model?: string;
  preamble?: string;
  workingDir?: string;
  env?: Record<string, string>;
}

export interface SpawnRequest {
  personaId?: string;
  task?: string;
  config?: SpawnConfig;
  spawnId?: string;
}

export interface SpawnResponse {
  spawnId: string;
  agentId: string;
  status: 'spawning' | 'running' | 'failed';
  beaconUrl: string;
  message?: string;
}

export interface SpawnStatus {
  spawnId: string;
  agentId: string | null;
  status: 'spawning' | 'running' | 'failed' | 'terminated';
  createdAt: number;
  startedAt?: number;
  terminatedAt?: number;
  exitCode?: number;
  error?: string;
}

export interface SpawnRecord {
  id: string;
  agentId: string | null;
  personaId: string | null;
  task: string | null;
  configJson: string | null;
  status: 'spawning' | 'running' | 'failed' | 'terminated';
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  terminatedAt: number | null;
  exitCode: number | null;
}

// === Spawn Configuration (CLI) ===

export interface SpawnBeaconConfig {
  spawnAgentPath: string;
  spawnTimeoutMs: number;
  maxConcurrentSpawns: number;
}

// === Beacon Config Types ===

export interface BeaconConfigEntry {
  key: string;
  value: string; // JSON string
  scope: 'local' | 'swarm';
  createdAt: number;
  updatedAt: number;
}

export interface CreateConfigRequest {
  key: string;
  value: string; // JSON string
  scope?: 'local' | 'swarm'; // default: "local"
}

// === Event Log Types ===

export type EventType =
  | 'agent.connected'
  | 'agent.disconnected'
  | 'agent.heartbeat'
  | 'agent.spawned'
  | 'agent.terminated'
  | 'message.sent'
  | 'message.delivered'
  | 'persona.created'
  | 'persona.updated'
  | 'persona.deleted'
  | 'skill.created'
  | 'skill.updated'
  | 'skill.deleted'
  | 'sync.completed'
  | 'sync.failed';

export interface EventLog {
  id: string;
  eventType: EventType;
  agentId: string | null;
  targetId: string | null;
  targetType: string | null;
  metadata: string | null;
  timestamp: number;
}

export interface CreateEventLogRequest {
  eventType: EventType;
  agentId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  metadata?: Record<string, unknown>;
}
