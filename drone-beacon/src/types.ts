export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope: "local" | "coordinator";
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope: "local" | "coordinator";
  createdAt: number;
  updatedAt: number;
}

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

export interface CreatePersonaRequest {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export interface CreateSkillRequest {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
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
  status: "spawning" | "running" | "failed";
  beaconUrl: string;
  message?: string;
}

export interface SpawnStatus {
  spawnId: string;
  agentId: string | null;
  status: "spawning" | "running" | "failed" | "terminated";
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
  status: "spawning" | "running" | "failed" | "terminated";
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