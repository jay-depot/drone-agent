import { describe, expect, it } from 'vitest';
import {
  buildResumeArgv,
  validateResumeArgv,
} from '../src/plugins/herdr/resume-argv.js';

describe('buildResumeArgv', () => {
  const base = {
    resumeCommand: 'drone-agent',
    sessionId: 'agent-1',
    personaId: null,
  };

  it('builds the minimal resume command', () => {
    expect(buildResumeArgv(base)).toEqual([
      'drone-agent',
      '--swarm.session-import',
      'agent-1',
    ]);
  });

  it('includes the persona when present', () => {
    expect(buildResumeArgv({ ...base, personaId: 'reviewer' })).toEqual([
      'drone-agent',
      '--swarm.session-import',
      'agent-1',
      '--persona',
      'reviewer',
    ]);
  });

  it('includes model / beacon overrides only when provided', () => {
    expect(
      buildResumeArgv({
        ...base,
        modelOverride: 'ollama/llama3.1',
        beaconHost: '10.0.0.5',
        beaconPort: 3457,
      })
    ).toEqual([
      'drone-agent',
      '--swarm.session-import',
      'agent-1',
      '--model',
      'ollama/llama3.1',
      '--beacon-host',
      '10.0.0.5',
      '--beacon-port',
      '3457',
    ]);
  });

  it('never includes the resume-hostile flags', () => {
    const argv = buildResumeArgv({
      ...base,
      personaId: 'p',
      modelOverride: 'm',
      beaconHost: 'h',
      beaconPort: 1,
    });
    for (const forbidden of [
      '--session-id',
      '--spawn-id',
      '--swarm',
      '--once',
      '--output-json',
      '--working-dir',
    ]) {
      expect(argv).not.toContain(forbidden);
    }
  });
});

describe('validateResumeArgv', () => {
  it('accepts a well-formed command', () => {
    expect(
      validateResumeArgv(['drone-agent', '--swarm.session-import', 'agent-1'])
    ).toEqual({ ok: true });
  });

  it('rejects an empty argv', () => {
    expect(validateResumeArgv([]).ok).toBe(false);
  });

  it('rejects a path-like argv[0]', () => {
    expect(validateResumeArgv(['/usr/bin/drone-agent']).ok).toBe(false);
    expect(validateResumeArgv(['bin\\drone-agent']).ok).toBe(false);
  });

  it('rejects apostrophes and control characters', () => {
    expect(validateResumeArgv(['drone-agent', "it's"]).ok).toBe(false);
    expect(validateResumeArgv(['drone-agent', 'a\u0007b']).ok).toBe(false);
  });

  it('rejects more than 64 args', () => {
    const argv = [
      'drone-agent',
      ...Array.from({ length: 64 }, (_, i) => `a${i}`),
    ];
    expect(argv.length).toBe(65);
    expect(validateResumeArgv(argv).ok).toBe(false);
  });

  it('rejects more than 8 KiB total', () => {
    expect(validateResumeArgv(['drone-agent', 'x'.repeat(8200)]).ok).toBe(
      false
    );
  });
});
