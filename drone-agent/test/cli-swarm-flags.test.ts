import { describe, expect, it } from 'vitest';
import { parseCliInvocation } from '../src/index.js';

describe('parseCliInvocation — swarm spawn flags', () => {
  it('parses --swarm as a boolean flag', () => {
    const inv = parseCliInvocation(['--swarm', '--output-json']);
    expect(inv.kind).toBe('default');
    expect(inv.options.swarm).toBe(true);
    expect(inv.options.outputJson).toBe(true);
  });

  it('defaults swarm to false', () => {
    const inv = parseCliInvocation([]);
    expect(inv.options.swarm).toBe(false);
  });

  it('parses --session-id', () => {
    const inv = parseCliInvocation(['--swarm', '--session-id', 'agent-abc']);
    expect(inv.options.sessionId).toBe('agent-abc');
  });

  it('parses --beacon-host and --beacon-port', () => {
    const inv = parseCliInvocation([
      '--swarm',
      '--beacon-host',
      '10.0.0.5',
      '--beacon-port',
      '3457',
    ]);
    expect(inv.options.beaconHost).toBe('10.0.0.5');
    expect(inv.options.beaconPort).toBe(3457);
  });

  it('rejects a non-numeric --beacon-port', () => {
    expect(() => parseCliInvocation(['--beacon-port', 'not-a-port'])).toThrow(
      /Invalid --beacon-port/
    );
  });

  it('rejects a negative --beacon-port', () => {
    expect(() => parseCliInvocation(['--beacon-port', '-1'])).toThrow(
      /Invalid --beacon-port/
    );
  });

  it('parses --task and --working-dir without throwing', () => {
    const inv = parseCliInvocation([
      '--swarm',
      '--task',
      'review the code',
      '--working-dir',
      '/tmp/work',
    ]);
    expect(inv.options.task).toBe('review the code');
    expect(inv.options.workingDir).toBe('/tmp/work');
  });

  it('accepts the full spawner argument set (step-0 blocker regression)', () => {
    // The beacon spawner passes exactly these flags; parseCliArgs must not
    // throw on any of them.
    expect(() =>
      parseCliInvocation([
        '--swarm',
        '--session-id',
        'agent-1',
        '--beacon-host',
        'localhost',
        '--beacon-port',
        '3457',
        '--output-json',
        '--persona',
        'coder',
      ])
    ).not.toThrow();
  });

  it('falls back to DRONE_SESSION_ID env for sessionId', () => {
    const prev = process.env.DRONE_SESSION_ID;
    process.env.DRONE_SESSION_ID = 'env-agent';
    try {
      const inv = parseCliInvocation([]);
      expect(inv.options.sessionId).toBe('env-agent');
    } finally {
      if (prev === undefined) {
        delete process.env.DRONE_SESSION_ID;
      } else {
        process.env.DRONE_SESSION_ID = prev;
      }
    }
  });
});
