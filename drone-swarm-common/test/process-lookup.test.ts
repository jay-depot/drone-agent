import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import {
  matchPidBySpawnId,
  parsePsOutput,
  listProcesses,
  findPidBySpawnId,
  type ProcessInfo,
} from '../src/process-lookup.js';

function resolveWith(stdout: string): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], cb: (err: unknown, out?: unknown) => void) =>
      cb(null, { stdout })
  );
}

describe('parsePsOutput', () => {
  it('parses pid and tokenized argv per line', () => {
    const out = [
      '  123 /usr/bin/drone-agent --swarm --spawn-id spawn-1',
      '  456 node /path/to/other.js',
    ].join('\n');
    expect(parsePsOutput(out)).toEqual([
      {
        pid: 123,
        argv: ['/usr/bin/drone-agent', '--swarm', '--spawn-id', 'spawn-1'],
      },
      { pid: 456, argv: ['node', '/path/to/other.js'] },
    ]);
  });

  it('skips malformed and blank lines', () => {
    const out = ['', '   ', 'not-a-pid foo', '  789 ps'].join('\n');
    expect(parsePsOutput(out)).toEqual([{ pid: 789, argv: ['ps'] }]);
  });
});

describe('matchPidBySpawnId', () => {
  it('matches the exact --spawn-id pair', () => {
    const procs: ProcessInfo[] = [
      { pid: 1, argv: ['drone-agent', '--spawn-id', 'spawn-1'] },
      { pid: 2, argv: ['drone-agent', '--spawn-id', 'spawn-2'] },
    ];
    expect(matchPidBySpawnId(procs, 'spawn-2')).toBe(2);
  });

  it('does not match a prefix or a missing flag', () => {
    const procs: ProcessInfo[] = [
      { pid: 1, argv: ['drone-agent', '--spawn-id', 'spawn-12'] },
      { pid: 2, argv: ['drone-agent', '--session-id', 'spawn-1'] },
    ];
    expect(matchPidBySpawnId(procs, 'spawn-1')).toBeNull();
  });

  it('ignores a trailing --spawn-id with no value', () => {
    const procs: ProcessInfo[] = [{ pid: 1, argv: ['drone-agent', '--spawn-id'] }];
    expect(matchPidBySpawnId(procs, 'spawn-1')).toBeNull();
  });
});

describe('listProcesses', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses ps output into processes', async () => {
    resolveWith('  42 drone-agent --spawn-id spawn-1');
    await expect(listProcesses()).resolves.toEqual([
      { pid: 42, argv: ['drone-agent', '--spawn-id', 'spawn-1'] },
    ]);
  });

  it('returns empty when ps is unavailable', async () => {
    execFileMock.mockImplementation(
      (_f: string, _a: string[], cb: (err: unknown) => void) =>
        cb(new Error('spawn ps ENOENT'))
    );
    await expect(listProcesses()).resolves.toEqual([]);
  });
});

describe('findPidBySpawnId', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('resolves the pid from live ps output', async () => {
    resolveWith(
      ['  10 drone-agent --spawn-id other', '  20 drone-agent --spawn-id target'].join(
        '\n'
      )
    );
    await expect(findPidBySpawnId('target')).resolves.toBe(20);
  });

  it('resolves null when enumeration is unavailable', async () => {
    execFileMock.mockImplementation(
      (_f: string, _a: string[], cb: (err: unknown) => void) =>
        cb(new Error('ps unsupported'))
    );
    await expect(findPidBySpawnId('target')).resolves.toBeNull();
  });
});
