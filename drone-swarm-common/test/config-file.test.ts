import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadConfigFile,
  mergeConfig,
  validateConfigFile,
} from '../src/config-file.js';

describe('validateConfigFile', () => {
  it('accepts a fully valid config', () => {
    const errors = validateConfigFile({
      port: 3457,
      host: '0.0.0.0',
      webPort: 8080,
      webHost: '127.0.0.1',
      dbPath: '/tmp/x.db',
      useHttps: false,
      sessionEnd: {
        type: 'command',
        command: 'echo done {session_id}',
      },
    });
    expect(errors).toEqual([]);
  });

  it('accepts an empty object', () => {
    expect(validateConfigFile({})).toEqual([]);
  });

  it('rejects non-object values', () => {
    expect(validateConfigFile(null)).toEqual([
      'config file must be a JSON object',
    ]);
    expect(validateConfigFile([1, 2])).toEqual([
      'config file must be a JSON object',
    ]);
    expect(validateConfigFile('nope')).toEqual([
      'config file must be a JSON object',
    ]);
  });

  it('rejects unknown top-level keys', () => {
    expect(validateConfigFile({ prot: 1234 })).toEqual(['unknown key "prot"']);
  });

  it('rejects wrong-typed scalars', () => {
    expect(validateConfigFile({ port: 'x' })).toEqual([
      '"port" must be a finite number',
    ]);
    expect(validateConfigFile({ webPort: NaN })).toEqual([
      '"webPort" must be a finite number',
    ]);
    expect(validateConfigFile({ host: 42 })).toEqual([
      '"host" must be a string',
    ]);
    expect(validateConfigFile({ dbPath: {} })).toEqual([
      '"dbPath" must be a string',
    ]);
    expect(validateConfigFile({ useHttps: 'yes' })).toEqual([
      '"useHttps" must be a boolean',
    ]);
  });

  it('collects multiple errors at once', () => {
    const errors = validateConfigFile({ port: 'x', host: 1 });
    expect(errors).toEqual([
      '"port" must be a finite number',
      '"host" must be a string',
    ]);
  });

  it('rejects invalid sessionEnd variants', () => {
    expect(validateConfigFile({ sessionEnd: {} })).toEqual([
      '"sessionEnd.type" must be "command" or "spawn"',
    ]);
    expect(validateConfigFile({ sessionEnd: { type: 'nope' } })).toEqual([
      '"sessionEnd.type" must be "command" or "spawn"',
    ]);
    expect(
      validateConfigFile({ sessionEnd: { type: 'command', command: '' } })
    ).toEqual(['"sessionEnd.command" must be a non-empty string']);
    expect(
      validateConfigFile({
        sessionEnd: { type: 'command', command: 'x', persona: 'p' },
      })
    ).toEqual(['unknown key "sessionEnd.persona" for type "command"']);
    expect(validateConfigFile({ sessionEnd: { type: 'spawn' } })).toEqual([
      '"sessionEnd.persona" must be a non-empty string',
    ]);
    expect(
      validateConfigFile({
        sessionEnd: { type: 'spawn', persona: 'p', beaconId: 9 },
      })
    ).toEqual(['"sessionEnd.beaconId" must be a string']);
    expect(
      validateConfigFile({
        sessionEnd: { type: 'spawn', persona: 'p', extra: true },
      })
    ).toEqual(['unknown key "sessionEnd.extra" for type "spawn"']);
    expect(validateConfigFile({ sessionEnd: 'command' })).toEqual([
      '"sessionEnd" must be an object',
    ]);
  });

  it('accepts both sessionEnd variants with exact keys only', () => {
    expect(
      validateConfigFile({
        sessionEnd: { type: 'command', command: 'run.sh {session_id}' },
      })
    ).toEqual([]);
    expect(
      validateConfigFile({
        sessionEnd: { type: 'spawn', persona: 'librarian' },
      })
    ).toEqual([]);
    expect(
      validateConfigFile({
        sessionEnd: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
      })
    ).toEqual([]);
  });
});

describe('loadConfigFile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'config-file-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a valid file', async () => {
    const file = path.join(dir, 'good.json');
    await writeFile(
      file,
      JSON.stringify({
        port: 4000,
        sessionEnd: { type: 'command', command: 'true' },
      })
    );
    await expect(loadConfigFile(file)).resolves.toEqual({
      port: 4000,
      sessionEnd: { type: 'command', command: 'true' },
    });
  });

  it('throws with clear error for missing file', async () => {
    const file = path.join(dir, 'missing.json');
    await expect(loadConfigFile(file)).rejects.toThrow(
      `Config file ${file} does not exist`
    );
  });

  it('throws for invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await writeFile(file, '{not json');
    await expect(loadConfigFile(file)).rejects.toThrow(/not valid JSON/);
  });

  it('throws for a directory path', async () => {
    await expect(loadConfigFile(dir)).rejects.toThrow(/is a directory/);
  });

  it('reports validation problems with the file path prefixed', async () => {
    const file = path.join(dir, 'invalid.json');
    await writeFile(file, JSON.stringify({ prot: 1 }));
    await expect(loadConfigFile(file)).rejects.toThrow(
      /is invalid:[\s\S]*unknown key "prot"/
    );
  });
});

describe('mergeConfig', () => {
  interface Example {
    port: number;
    host?: string;
    sessionEnd?: { type: string; command?: string; persona?: string };
  }

  it('returns defaults when only defaults given', () => {
    const defaults: Example = { port: 3457 };
    expect(mergeConfig(defaults)).toEqual({ port: 3457 });
  });

  it('lets later sources win per top-level key', () => {
    const merged = mergeConfig<Example>(
      { port: 3457, host: 'a', sessionEnd: { type: 'command' } },
      { port: 4000 }
    );
    expect(merged).toEqual({
      port: 4000,
      host: 'a',
      sessionEnd: { type: 'command' },
    });
  });

  it('skips undefined sources and undefined values', () => {
    const merged = mergeConfig<Example>(
      undefined,
      { port: 1 },
      { port: undefined as unknown as number, host: 'b' }
    );
    expect(merged).toEqual({ port: 1, host: 'b' });
  });

  it('deep-merges sessionEnd across sources', () => {
    const merged = mergeConfig<Example>(
      { port: 1, sessionEnd: { type: 'command', command: 'one' } },
      { port: 2, sessionEnd: { type: 'command', command: 'two' } }
    );
    expect(merged.sessionEnd).toEqual({ type: 'command', command: 'two' });
  });

  it('replaces sessionEnd wholesale when shapes differ', () => {
    const merged = mergeConfig<Example>(
      { port: 1, sessionEnd: { type: 'command', command: 'x' } },
      { port: 2, sessionEnd: { type: 'spawn', persona: 'p' } }
    );
    expect(merged.sessionEnd).toEqual({ type: 'spawn', persona: 'p' });
  });

  it('does not mutate inputs', () => {
    const defaults: Example = { port: 1 };
    const file: Example = { port: 2, host: 'h' };
    mergeConfig(defaults, file);
    expect(defaults).toEqual({ port: 1 });
    expect(file).toEqual({ port: 2, host: 'h' });
  });
});
