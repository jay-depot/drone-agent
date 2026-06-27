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
  approvalToken: string | null;
  approvedAt: number | null;
  tlsFingerprint: string | null;
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
  approvalToken?: string; // Only provided when status is 'pending'
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