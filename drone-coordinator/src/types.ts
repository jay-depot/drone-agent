// Shared types imported from drone-core
export type {
  Persona,
  Skill,
  CreatePersonaRequest,
  CreateSkillRequest,
} from 'drone-core';

// === Coordinator-specific types ===

export interface Beacon {
  id: string;
  name: string;
  host: string;
  port: number;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface RegisterBeaconRequest {
  id: string;
  name: string;
  host: string;
  port: number;
  publicKey?: string; // Ed25519 public key (base64)
  tlsFingerprint?: string; // SHA-256 of TLS cert for pinning
}

// === Beacon Trust Types ===

export type BeaconTrustStatus = 'pending' | 'approved' | 'rejected';

export interface BeaconTrust {
  beaconId: string;
  name: string;
  publicKey: string; // Ed25519 public key (base64)
  host: string;
  port: number;
  status: BeaconTrustStatus;
  approvedAt: number | null;
  tlsFingerprint: string | null;
  verificationCode: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterBeaconTrustRequest {
  id: string;
  name: string;
  host: string;
  port: number;
  publicKey: string;
  tlsFingerprint?: string;
}

export interface BeaconStatusResponse {
  status: BeaconTrustStatus;
  verificationCode?: string; // Human-readable code for MitM verification
}

export interface BeaconSession {
  id: string;
  beaconId: string;
  agentId: string;
  personaId: string | null;
  connectedAt: number;
  disconnectedAt: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionRequest {
  id: string;
  agentId: string;
  personaId?: string;
}

export interface EndSessionRequest {
  disconnectedAt: number;
  durationMs: number;
}

// === Knowledge Types ===

export type KnowledgeType =
  'fact' | 'preference' | 'skill_pattern' | 'principle';

export interface Knowledge {
  id: string;
  type: KnowledgeType;
  key: string;
  value: string; // JSON-encoded content
  sourceBeaconId: string | null;
  sourceAgentId: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateKnowledgeRequest {
  id: string;
  type: KnowledgeType;
  key: string;
  value: string;
  sourceBeaconId?: string;
  sourceAgentId?: string;
  confidence?: number;
}

export interface UpdateKnowledgeRequest {
  type?: KnowledgeType;
  key?: string;
  value?: string;
  confidence?: number;
}

export interface SearchKnowledgeQuery {
  q?: string; // Search query
  type?: KnowledgeType; // Filter by type
}

// === Spawn Types ===

export interface SpawnConfig {
  model?: string;
  preamble?: string;
  workingDir?: string;
  env?: Record<string, string>;
}

export interface SpawnRequest {
  targetBeaconId: string;
  personaId?: string;
  task?: string;
  config?: SpawnConfig;
  spawnId?: string;
}
