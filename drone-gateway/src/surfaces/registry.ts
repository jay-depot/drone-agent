import type { SurfaceFactory } from './types.js';

export class SurfaceRegistry {
  private factories = new Map<string, SurfaceFactory>();

  register(type: string, factory: SurfaceFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Duplicate control surface type: ${type}`);
    }
    this.factories.set(type, factory);
  }

  get(type: string): SurfaceFactory | undefined {
    return this.factories.get(type);
  }

  types(): string[] {
    return [...this.factories.keys()].sort();
  }
}
