import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  sendBeaconCommand,
  isBeaconConnected,
  resetBeaconConnections,
  startBeaconLivenessSweep,
  _registerTestConnection,
  _handleIncomingMessage,
  _setLifecycleHooks,
} from '../src/beacon-ws.js';
import type { WebSocket } from '@fastify/websocket';

function makeFakeWs() {
  const send = vi.fn((data: string, cb?: (err?: Error) => void) => cb?.());
  const ping = vi.fn();
  const terminate = vi.fn();
  const handlers = new Map<string, () => void>();
  const ws = {
    send,
    ping,
    terminate,
    on: vi.fn((ev: string, cb: () => void) => {
      handlers.set(ev, cb);
    }),
    close: vi.fn(),
    readyState: 1,
    handlers,
  };
  return Object.assign(ws as unknown as WebSocket, { send, ping, terminate });
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
    const sent = JSON.parse(String(ws.send.mock.calls[0][0]));
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
    ws.send.mockImplementation((_data: string, cb?: (err?: Error) => void) =>
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

describe('beacon connection lifecycle events', () => {
  it('publishes a connected event when a connection is registered', () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    _setLifecycleHooks({ onConnected, onDisconnected });

    _registerTestConnection('b1', makeFakeWs());

    expect(onConnected).toHaveBeenCalledWith('b1');
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('publishes a disconnected event when a connection is removed', () => {
    const onDisconnected = vi.fn();
    _setLifecycleHooks({ onDisconnected });
    _registerTestConnection('b1', makeFakeWs());

    resetBeaconConnections();

    expect(onDisconnected).toHaveBeenCalledWith('b1');
  });
});

describe('startBeaconLivenessSweep', () => {
  it('terminates a beacon that fails to pong across sweeps', () => {
    vi.useFakeTimers();

    const deadWs = makeFakeWs();
    _registerTestConnection('dead', deadWs);

    const sweep = startBeaconLivenessSweep(1000);
    try {
      // First sweep pings the beacon and marks it not-alive.
      vi.advanceTimersByTime(1000);
      expect(deadWs.ping).toHaveBeenCalledTimes(1);

      // Second sweep: the beacon never ponged, so it is terminated.
      vi.advanceTimersByTime(1000);
      expect(deadWs.terminate).toHaveBeenCalledTimes(1);
      expect(isBeaconConnected('dead')).toBe(false);
    } finally {
      clearInterval(sweep);
      vi.useRealTimers();
    }
  });

  it('keeps a beacon that ponged alive across sweeps', () => {
    vi.useFakeTimers();

    const aliveWs = makeFakeWs();
    _registerTestConnection('alive', aliveWs);

    // registerBeaconConnection wires `pong` → restore liveness. Make the fake
    // ws "pong back" immediately whenever it is pinged.
    aliveWs.ping.mockImplementation(() => {
      aliveWs.handlers.get('pong')?.();
    });

    const sweep = startBeaconLivenessSweep(1000);
    try {
      // First sweep pings; the beacon pongs back, restoring liveness.
      vi.advanceTimersByTime(1000);
      // Second sweep should ping again (not terminate).
      vi.advanceTimersByTime(1000);
      expect(aliveWs.ping).toHaveBeenCalledTimes(2);
      expect(aliveWs.terminate).not.toHaveBeenCalled();
      expect(isBeaconConnected('alive')).toBe(true);
    } finally {
      clearInterval(sweep);
      vi.useRealTimers();
    }
  });
});
