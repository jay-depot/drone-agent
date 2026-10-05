import { describe, expect, it } from 'vitest';
import { ConsoleCommandRegistry } from '../src/console/registry.js';
import { parseCommand } from '../src/console/parse.js';
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

function registryWith(...commands: ConsoleCommand[]): ConsoleCommandRegistry {
  const registry = new ConsoleCommandRegistry();
  for (const command of commands) registry.register(command);
  return registry;
}

describe('parseCommand', () => {
  it('returns null for an empty line', () => {
    expect(parseCommand('', registryWith())).toBeNull();
    expect(parseCommand('   ', registryWith())).toBeNull();
  });

  it('returns null when the first token is not a swarm. command', () => {
    expect(parseCommand('hello there', registryWith())).toBeNull();
    expect(parseCommand('/help', registryWith())).toBeNull();
  });

  it('parses a bare command with no args', () => {
    const registry = registryWith(makeCommand('swarm.beacon.list'));
    expect(parseCommand('swarm.beacon.list', registry)).toEqual({
      name: 'swarm.beacon.list',
      positionals: [],
      flags: {},
      json: false,
    });
  });

  it('collects positionals in order', () => {
    const registry = registryWith(makeCommand('swarm.agent.inject'));
    const parsed = parseCommand(
      'swarm.agent.inject agent-1 "hello there"',
      registry
    );
    expect(parsed?.positionals).toEqual(['agent-1', 'hello there']);
  });

  it('parses a declared value flag with its value', () => {
    const registry = registryWith(
      makeCommand('swarm.beacon.spawn', ['persona', 'task'])
    );
    const parsed = parseCommand(
      'swarm.beacon.spawn beacon-1 --persona coder --task "fix bug"',
      registry
    );
    expect(parsed?.positionals).toEqual(['beacon-1']);
    expect(parsed?.flags).toEqual({ persona: 'coder', task: 'fix bug' });
  });

  it('treats an undeclared flag as boolean true', () => {
    const registry = registryWith(makeCommand('swarm.session.list'));
    const parsed = parseCommand('swarm.session.list --status', registry);
    expect(parsed?.flags).toEqual({ status: true });
  });

  it('does not consume a following flag token as a value', () => {
    const registry = registryWith(makeCommand('swarm.session.list', ['limit']));
    const parsed = parseCommand(
      'swarm.session.list --limit --offset',
      registry
    );
    expect(parsed?.flags).toEqual({ limit: true, offset: true });
  });

  it('sets json when --json is present', () => {
    const registry = registryWith(makeCommand('swarm.beacon.list'));
    const parsed = parseCommand('swarm.beacon.list --json', registry);
    expect(parsed?.json).toBe(true);
    expect(parsed?.flags).toEqual({ json: true });
  });

  it('leaves json false when absent', () => {
    const registry = registryWith(makeCommand('swarm.beacon.list'));
    expect(parseCommand('swarm.beacon.list', registry)?.json).toBe(false);
  });

  it('parses an unknown swarm. command name with no declared flags', () => {
    const registry = registryWith();
    const parsed = parseCommand('swarm.nope.x --foo bar', registry);
    expect(parsed).toEqual({
      name: 'swarm.nope.x',
      positionals: ['bar'],
      flags: { foo: true },
      json: false,
    });
  });
});
