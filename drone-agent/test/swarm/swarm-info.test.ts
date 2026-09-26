import { describe, expect, it, vi } from 'vitest';
import {
  createSwarmInfoStore,
  refreshSwarmInfo,
  startSwarmInfoRefresh,
} from '../../src/plugins/swarm/swarm-info.js';
import { silentLogger } from '../helpers.js';

function infoResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('swarm info store', () => {
  it('applies beacon info and roster snapshots', () => {
    const store = createSwarmInfoStore('localhost:3457');
    expect(store.getInfo()).toBeNull();
    expect(store.getRoster()).toEqual([]);
    expect(store.getLocalAddress()).toBe('localhost:3457');

    store.applyBeaconInfo({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: 'coord',
      coordinatorPort: 3456,
    });
    store.replaceRoster([
      {
        id: 'b1',
        name: 'home-office',
        host: 'localhost',
        port: 3457,
        connected: true,
        trustStatus: 'approved',
      },
    ]);
    expect(store.getInfo()?.name).toBe('home-office');
    expect(store.getRoster()).toHaveLength(1);
  });
});

describe('refreshSwarmInfo', () => {
  it('applies info and roster on success', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/info')) {
        return infoResponse({
          id: 'b1',
          name: 'home-office',
          coordinatorHost: 'coord',
          coordinatorPort: 3456,
        });
      }
      return infoResponse([
        {
          id: 'b1',
          name: 'home-office',
          host: 'localhost',
          port: 3457,
          connected: true,
          trustStatus: 'approved',
        },
        { id: 'b2', name: 'workshop', host: '10.0.0.2', port: 3457 },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await refreshSwarmInfo(store, 'http://beacon.test', silentLogger());
      expect(store.getInfo()?.name).toBe('home-office');
      expect(store.getRoster()).toHaveLength(2);
      expect(store.getRoster()[1]).toMatchObject({
        id: 'b2',
        connected: false,
        trustStatus: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the last known values on transport failure', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    store.applyBeaconInfo({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: null,
      coordinatorPort: null,
    });
    store.replaceRoster([
      {
        id: 'b1',
        name: 'home-office',
        host: 'localhost',
        port: 3457,
        connected: true,
        trustStatus: 'approved',
      },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down'))
    );
    try {
      await refreshSwarmInfo(store, 'http://beacon.test', silentLogger());
      expect(store.getInfo()?.name).toBe('home-office');
      expect(store.getRoster()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never regresses the roster to empty on a non-array response', async () => {
    const store = createSwarmInfoStore('localhost:3457');
    store.replaceRoster([
      {
        id: 'b1',
        name: 'home-office',
        host: 'localhost',
        port: 3457,
        connected: true,
        trustStatus: 'approved',
      },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/info')
          ? infoResponse({ id: 'b1', name: 'home-office' })
          : infoResponse({ error: 'coordinator unavailable' })
      )
    );
    try {
      await refreshSwarmInfo(store, 'http://beacon.test', silentLogger());
      expect(store.getRoster()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('startSwarmInfoRefresh', () => {
  it('refreshes on the interval and clears cleanly', async () => {
    vi.useFakeTimers();
    const store = createSwarmInfoStore('localhost:3457');
    const fetchMock = vi.fn(async (_url: string) => infoResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const interval = startSwarmInfoRefresh(
        store,
        'http://beacon.test',
        silentLogger()
      );
      expect(fetchMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(fetchMock).toHaveBeenCalled();
      clearInterval(interval);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
