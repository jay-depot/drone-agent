/**
 * Integration Test Fixtures Library
 *
 * Shared utilities for swarm integration testing.
 * Provides container lifecycle, HTTP utilities, swarm utilities, and assertions.
 */

// Re-export all utilities
export * from './docker.js';
export * from './http.js';
export * from './swarm.js';
export * from './assertions.js';

// Common types
export interface TestEnvironment {
  coordinatorUrl: string;
  beaconUrl: string;
  agentUrl: string;
  echoLlmUrl: string;
  containerIds: string[];
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
}

export interface CreatePersonaRequest {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
}

export interface Persona {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name?: string;
  status: 'connected' | 'disconnected' | 'busy' | 'idle';
  persona?: string;
  lastActivity: string;
  capabilities?: string[];
}

export interface Message {
  id: string;
  from: string;
  to: string;
  channel?: string;
  body: object;
  delivered: boolean;
  readAt?: string;
  createdAt: string;
}
