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