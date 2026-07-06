import type {
  DroneInsightStorageEngine,
  DronePrincipleStorageEngine,
} from 'drone-core';

/** In-memory counter for insights recorded this session. */
export let insightCount = 0;

export function incrementInsightCount(): void {
  insightCount += 1;
}

/** Registry of storage engines for insights. */
export const insightEngines = new Map<string, DroneInsightStorageEngine>();

/** Registry of storage engines for principles. */
export const principleEngines = new Map<string, DronePrincipleStorageEngine>();
