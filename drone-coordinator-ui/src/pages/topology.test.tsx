import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';
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
    <ToastProvider>
      <AuthProvider>
        <WebSocketProvider>{children}</WebSocketProvider>
      </AuthProvider>
    </ToastProvider>
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

describe('TopologyPage trust dialog', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    vi.restoreAllMocks();
  });

  function stubTrustApi(
    initialBeacons: unknown,
    actionUrl: string,
    actionMethod: string,
    actionResponse: Response,
    refetchedBeacons?: unknown
  ) {
    let beaconsCalls = 0;
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/beacons' && method === 'GET') {
        beaconsCalls++;
        return jsonResponse(
          200,
          beaconsCalls === 1
            ? initialBeacons
            : (refetchedBeacons ?? initialBeacons)
        );
      }
      if (url === '/api/agents/location') {
        return jsonResponse(200, []);
      }
      if (url === actionUrl && method === actionMethod) {
        return actionResponse;
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  async function confirmAction(action: 'Approve' | 'Reject' | 'Remove') {
    renderTopology();
    await screen.findByText('B1');
    await userEvent.click(screen.getByRole('button', { name: action }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: action }));
  }

  it('shows an error toast and keeps the dialog open when approve fails', async () => {
    stubTrustApi(
      [makeBeacon({ trustStatus: 'pending', connected: false, fingerprintConfirmed: true })],
      '/api/beacons/trust/b1/approve',
      'POST',
      jsonResponse(409, { error: 'Beacon revoked the request' })
    );

    await confirmAction('Approve');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Beacon revoked the request');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a fallback toast and keeps the dialog open when remove fails', async () => {
    stubTrustApi(
      [makeBeacon({ trustStatus: 'approved', connected: true })],
      '/api/beacons/trust/b1',
      'DELETE',
      jsonResponse(500, {})
    );

    await confirmAction('Remove');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 500: Unknown error');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the dialog and refetches beacons when reject succeeds', async () => {
    const mockFetch = stubTrustApi(
      [makeBeacon({ trustStatus: 'pending', connected: false })],
      '/api/beacons/trust/b1/reject',
      'POST',
      jsonResponse(200, {}),
      [makeBeacon({ trustStatus: 'rejected', connected: false })]
    );

    await confirmAction('Reject');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const beaconsCalls = mockFetch.mock.calls.filter(
      ([url]) => url === '/api/beacons'
    );
    expect(beaconsCalls).toHaveLength(2);
    expect(screen.getByText('rejected')).toBeInTheDocument();
  });

  it('closes the dialog and refetches beacons when remove succeeds', async () => {
    const mockFetch = stubTrustApi(
      [makeBeacon({ trustStatus: 'approved', connected: true })],
      '/api/beacons/trust/b1',
      'DELETE',
      jsonResponse(200, {}),
      [makeBeacon({ trustStatus: 'rejected', connected: false })]
    );

    await confirmAction('Remove');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const beaconsCalls = mockFetch.mock.calls.filter(
      ([url]) => url === '/api/beacons'
    );
    expect(beaconsCalls).toHaveLength(2);
  });
});
