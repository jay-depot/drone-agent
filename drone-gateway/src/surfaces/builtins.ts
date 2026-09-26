import type { SurfaceRegistry } from './registry.js';
import { createPersonaAssignmentSurface } from './persona-assignment.js';
import { createDiscardSurface } from './discard.js';
import { createSwarmConsoleSurface } from './swarm-console.js';

export function registerBuiltInSurfaces(registry: SurfaceRegistry): void {
  registry.register('persona-assignment', createPersonaAssignmentSurface);
  registry.register('discard', createDiscardSurface);
  registry.register('swarm-console', createSwarmConsoleSurface);
}
