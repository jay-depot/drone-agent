import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import TopologyPage from '@/pages/topology';
import type { ReactNode } from 'react';

// Mock WebSocket that records instances so tests can simulate live events.
const wsInstances: MockWebSocket[] = [];
class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  url = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
vi.stubGlobal('WebSocket', MockWebSocket);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <WebSocketProvider>{children}</WebSocketProvider>
    </AuthProvider>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function pushWsMessage(msg: unknown) {
  const ws = wsInstances[wsInstances.length - 1];
  ws.onmessage?.({ data: JSON.stringify(msg) });
}

function makeBeacon(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'B1',
    host: '10.0.0.1',
    port: 3457,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    trustStatus: 'approved' as const,
    connected: true,
    ...overrides,
  };
}

function renderTopology() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<TopologyPage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper }
  );
}

function mockApi(beacons: unknown) {
  const mockFetch = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/beacons') {
      return Promise.resolve(jsonResponse(200, beacons));
    }
    if (url === '/api/agents/location') {
      return Promise.resolve(jsonResponse(200, []));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

describe('TopologyPage beacon status dots', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('shows a green dot for a connected, approved beacon', async () => {
    mockApi([makeBeacon({ trustStatus: 'approved', connected: true })]);
    renderTopology();

    await waitFor(() => {
      expect(screen.getByTitle('Online')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Online')).toHaveClass('bg-green-500');
  });

  it('shows a red dot for an approved but disconnected beacon', async () => {
    mockApi([makeBeacon({ trustStatus: 'approved', connected: false })]);
    renderTopology();

    await waitFor(() => {
      expect(screen.getByTitle('Offline')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Offline')).toHaveClass('bg-red-400');
  });

  it('shows an amber dot for a pending (untrusted) beacon', async () => {
    mockApi([makeBeacon({ trustStatus: 'pending', connected: false })]);
    renderTopology();

    await waitFor(() => {
      expect(screen.getByTitle('Pending')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Pending')).toHaveClass('bg-amber-400');
  });

  it('updates the dot to red when a disconnected event arrives', async () => {
    mockApi([makeBeacon({ trustStatus: 'approved', connected: true })]);
    renderTopology();

    await waitFor(() => {
      expect(screen.getByTitle('Online')).toBeInTheDocument();
    });

    pushWsMessage({
      type: 'event',
      sessionId: 'b1',
      eventType: 'beacon.disconnected',
      payload: { beaconId: 'b1' },
    });

    await waitFor(() => {
      expect(screen.getByTitle('Offline')).toBeInTheDocument();
    });
  });

  it('updates the dot to green when a connected event arrives', async () => {
    mockApi([makeBeacon({ trustStatus: 'approved', connected: false })]);
    renderTopology();

    await waitFor(() => {
      expect(screen.getByTitle('Offline')).toBeInTheDocument();
    });

    pushWsMessage({
      type: 'event',
      sessionId: 'b1',
      eventType: 'beacon.connected',
      payload: { beaconId: 'b1' },
    });

    await waitFor(() => {
      expect(screen.getByTitle('Online')).toBeInTheDocument();
    });
  });
});
