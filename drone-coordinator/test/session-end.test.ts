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
import {
  _handleIncomingMessage,
  _registerTestConnection,
  resetBeaconConnections,
} from '../src/beacon-ws.js';

describe('coordinator runSessionEndHook', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'coord-session-end-test-'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    configureSessionEndHook({});
    resetBeaconConnections();
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
    expect(result).toEqual({
      ran: true,
      kind: 'command',
      error: 'exit code 5',
    });
  });

  it('kills forked children so the hook settles at the timeout', async () => {
    // A compound command forces the shell down the fork path even where
    // implicit-exec would normally avoid it; the grandchild inherits the
    // stdio pipes and previously held the close event open.
    configureSessionEndHook({
      commandTimeoutMs: 150,
      trigger: { type: 'command', command: 'sleep 10; true' },
    });
    const startedAt = Date.now();
    const result = await runSessionEndHook('session-a');
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result.ran).toBe(true);
    expect(result.kind).toBe('command');
    expect(result.error).toMatch(/terminated by|timed out/);
  }, 5000);

  it('forwards spawn triggers to the configured beacon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'spawning' }), {
            status: 202,
          })
      )
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
  // Reverse-channel (WebSocket) spawn path --------------------------

  function makeReverseChannelWs(onSend: (raw: string) => void) {
    return {
      send: vi.fn((data: string, cb?: (err?: Error) => void) => {
        onSend(data);
        cb?.();
      }),
      on: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
  }

  it('sends spawn triggers over the reverse channel when the beacon is connected', async () => {
    const ws = makeReverseChannelWs(raw => {
      const msg = JSON.parse(raw) as {
        id: string;
        command: string;
        payload: Record<string, unknown>;
      };
      expect(msg.command).toBe('spawn');
      queueMicrotask(() =>
        _handleIncomingMessage(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            ok: true,
            status: 202,
            body: { spawnId: 's-1' },
          })
        )
      );
    });
    _registerTestConnection('b-1', ws as never);

    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn' });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(ws.send.mock.calls[0][0] as string) as {
      payload: { personaId: string; task: string };
    };
    expect(body.payload.personaId).toBe('librarian');
    expect(body.payload.task).toContain('session-a');
  });

  it('does not fall back to HTTP on an app-level failure response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('unused', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const ws = makeReverseChannelWs(raw => {
      const msg = JSON.parse(raw) as { id: string };
      queueMicrotask(() =>
        _handleIncomingMessage(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            ok: false,
            status: 404,
            body: { error: 'persona not found' },
          })
        )
      );
    });
    _registerTestConnection('b-1', ws as never);

    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn', error: 'status 404' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to HTTP when the reverse channel fails to deliver', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const ws = makeReverseChannelWs(() => {
      // send overridden below: delivery fails
    });
    ws.send = vi.fn((_data: string, cb?: (err?: Error) => void) =>
      cb?.(new Error('socket closed'))
    );
    _registerTestConnection('b-1', ws as never);

    configureSessionEndHook({
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-1' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4599/spawn',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
