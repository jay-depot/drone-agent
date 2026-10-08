import type { SpawnBackend } from './spawn-backend.js';
import type { SpawnBackendType } from './types.js';

export class SpawnBackendRegistry {
  private backends = new Map<SpawnBackendType, SpawnBackend>();

  register(type: SpawnBackendType, backend: SpawnBackend): void {
    if (this.backends.has(type)) {
      throw new Error(`Duplicate spawn backend: ${type}`);
    }
    this.backends.set(type, backend);
  }

  get(type: SpawnBackendType): SpawnBackend | undefined {
    return this.backends.get(type);
  }

  types(): SpawnBackendType[] {
    return [...this.backends.keys()].sort();
  }
}
