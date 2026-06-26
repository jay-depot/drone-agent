// Shared types imported from drone-core
export type { Persona, Skill, CreatePersonaRequest, CreateSkillRequest } from 'drone-core';

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