import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  sendBeaconCommand,
  isBeaconConnected,
  resetBeaconConnections,
  _registerTestConnection,
  _handleIncomingMessage,
} from '../src/beacon-ws.js';
import type { WebSocket } from '@fastify/websocket';

function makeFakeWs() {
  const ws = {
    send: vi.fn((data: string, cb?: (err?: Error) => void) => cb?.()),
    on: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
  return ws as unknown as WebSocket;
}

beforeEach(() => {
  resetBeaconConnections();
});

describe('sendBeaconCommand', () => {
  it('rejects when the beacon is not connected', async () => {
    await expect(sendBeaconCommand('unknown', 'spawn')).rejects.toThrow(
      /not connected/
    );
  });

  it('sends a command and resolves with the response', async () => {
    const ws = makeFakeWs();
    _registerTestConnection('b1', ws);

    const promise = sendBeaconCommand('b1', 'spawn', { personaId: 'p1' });
    expect(ws.send).toHaveBeenCalled();

    // Parse the sent message to extract its id, then simulate the response.
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.type).toBe('command');
    expect(sent.command).toBe('spawn');
    expect(sent.payload).toEqual({ personaId: 'p1' });

    // Simulate the beacon sending a response — _handleIncomingMessage
    // dispatches it to the pending request resolver.
    _handleIncomingMessage(
      JSON.stringify({
        type: 'response',
        id: sent.id,
        ok: true,
        status: 202,
        body: { spawnId: 's1' },
      })
    );

    await expect(promise).resolves.toEqual({
      ok: true,
      status: 202,
      body: { spawnId: 's1' },
    });
  });

  it('rejects on timeout when no response arrives', async () => {
    vi.useFakeTimers();
    const ws = makeFakeWs();
    _registerTestConnection('b1', ws);

    const promise = sendBeaconCommand('b1', 'spawn', undefined, 100);
    const assertion = expect(promise).rejects.toThrow(/Timed out/);
    vi.advanceTimersByTime(200);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects when ws.send errors', async () => {
    const ws = makeFakeWs();
    (ws.send as any) = vi.fn(
      (_data: string, cb?: (err?: Error) => void) =>
        cb?.(new Error('send failed'))
    );
    _registerTestConnection('b1', ws);

    await expect(sendBeaconCommand('b1', 'spawn')).rejects.toThrow(
      'send failed'
    );
  });
});

describe('isBeaconConnected', () => {
  it('returns false for unknown beacons', () => {
    expect(isBeaconConnected('b1')).toBe(false);
  });

  it('returns true for a connected beacon', () => {
    const ws = makeFakeWs();
    _registerTestConnection('b1', ws);
    expect(isBeaconConnected('b1')).toBe(true);
  });
});