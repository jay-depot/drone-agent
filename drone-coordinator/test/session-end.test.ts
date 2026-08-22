import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
  getBeacon: (id: string) =>
    id === 'b-1'
      ? { id: 'b-1', host: '127.0.0.1', port: 4599, name: 'test-beacon' }
      : undefined,
}));

import {
  configureSessionEndHook,
  runSessionEndHook,
} from '../src/session-end.js';

describe('coordinator runSessionEndHook', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'coord-session-end-test-'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    configureSessionEndHook({});
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when not configured', async () => {
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: false, kind: 'none' });
  });

  it('runs a command trigger to completion', async () => {
    configureSessionEndHook({
      trigger: { type: 'command', command: 'exit 0' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'command' });
  });

  it('captures failing commands instead of throwing', async () => {
    configureSessionEndHook({
      trigger: { type: 'command', command: 'exit 5' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'command', error: 'exit code 5' });
  });

  it('forwards spawn triggers to the configured beacon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'spawning' }), {
        status: 202,
      }))
    );
    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn' });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4599/spawn',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.personaId).toBe('librarian');
    expect(body.task).toContain('session-a');
  });

  it('reports unknown beacons without throwing', async () => {
    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-missing' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result.ran).toBe(false);
    expect(result.error).toContain('beacon not found');
  });

  it('captures failed beacon forwards without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result.ran).toBe(true);
    expect(result.error).toBe('status 500');
  });

  it('captures network failures without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result.ran).toBe(true);
    expect(result.error).toContain('ECONNREFUSED');
  });
});
