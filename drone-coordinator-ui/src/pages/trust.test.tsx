import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import BeaconDetailPage from '@/pages/beacon-detail';
import TopologyPage from '@/pages/topology';
import type { ReactNode } from 'react';

// Mock WebSocket so the provider doesn't actually connect
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

describe('BeaconDetailPage verification code', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('displays the bidirectional verification code from the API', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/beacons/b1') {
        return Promise.resolve(
          jsonResponse(200, {
            id: 'b1',
            name: 'B1',
            host: '10.0.0.1',
            port: 3457,
            trustStatus: 'pending',
            verificationCode: 'acorn-badge-cabin-daisy',
          })
        );
      }
      if (url === '/api/beacons/b1/sessions') {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === '/api/agents/location?beaconId=b1') {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <MemoryRouter initialEntries={['/beacons/b1']}>
        <Routes>
          <Route path="/beacons/:id" element={<BeaconDetailPage />} />
        </Routes>
      </MemoryRouter>,
      { wrapper }
    );

    await waitFor(() => {
      expect(screen.getByText('acorn-badge-cabin-daisy')).toBeInTheDocument();
    });
  });
});

describe('TopologyPage approve by beacon ID', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/beacons/trust/:id/approve when approving a pending beacon', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/beacons') {
          return Promise.resolve(
            jsonResponse(200, [
              {
                id: 'b1',
                name: 'B1',
                host: '10.0.0.1',
                port: 3457,
                connectedAt: Date.now(),
                lastHeartbeat: Date.now(),
                trustStatus: 'pending',
              },
            ])
          );
        }
        if (url === '/api/agents/location') {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (
          url === '/api/beacons/trust/b1/approve' &&
          init?.method === 'POST'
        ) {
          return Promise.resolve(jsonResponse(200, { success: true }));
        }
        return Promise.resolve(jsonResponse(404, {}));
      });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<TopologyPage />} />
        </Routes>
      </MemoryRouter>,
      { wrapper }
    );

    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Approve'));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(
        within(dialog).getByText(/Approve beacon "B1"/)
      ).toBeInTheDocument();
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      const approveCall = mockFetch.mock.calls.find(
        ([url, init]) =>
          url === '/api/beacons/trust/b1/approve' && init?.method === 'POST'
      );
      expect(approveCall).toBeTruthy();
    });
  });
});
