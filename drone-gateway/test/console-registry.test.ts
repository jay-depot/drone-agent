import { describe, expect, it } from 'vitest';
import { ConsoleCommandRegistry } from '../src/console/registry.js';
import type { ConsoleCommand } from '../src/console/types.js';

function makeCommand(name: string, valueFlags?: string[]): ConsoleCommand {
  return {
    name,
    description: `desc ${name}`,
    usage: name,
    valueFlags,
    run: async () => 'ok',
  };
}

describe('ConsoleCommandRegistry', () => {
  it('registers and retrieves a command', () => {
    const registry = new ConsoleCommandRegistry();
    registry.register(makeCommand('swarm.help'));
    expect(registry.get('swarm.help')?.name).toBe('swarm.help');
  });

  it('returns undefined for an unknown command', () => {
    const registry = new ConsoleCommandRegistry();
    expect(registry.get('swarm.nope')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = new ConsoleCommandRegistry();
    registry.register(makeCommand('swarm.help'));
    expect(() => registry.register(makeCommand('swarm.help'))).toThrow(
      'Duplicate console command: swarm.help'
    );
  });

  it('lists commands sorted by name', () => {
    const registry = new ConsoleCommandRegistry();
    registry.register(makeCommand('swarm.session.list'));
    registry.register(makeCommand('swarm.beacon.list'));
    registry.register(makeCommand('swarm.agent.status'));
    expect(registry.list().map(c => c.name)).toEqual([
      'swarm.agent.status',
      'swarm.beacon.list',
      'swarm.session.list',
    ]);
  });
});
