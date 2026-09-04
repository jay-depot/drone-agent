import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import SessionsPage from './sessions';
import type { ReactNode } from 'react';

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

const sessionPayload = (status: string, id = 's-1') => ({
  id,
  beaconId: 'b1',
  personaId: null,
  status,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
});

describe('SessionsPage archive view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFetch(session: unknown) {
    return vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/sessions?')) {
        return Promise.resolve(
          jsonResponse(200, {
            sessions: [session],
            count: 1,
          })
        );
      }
      if (url === '/api/beacons') {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
  }

  it('default view requests exclude=archived', async () => {
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    const sessionsCall = mockFetch.mock.calls
      .map(([url]) => url)
      .find((u: string) => u.includes('/api/sessions?'));
    expect(sessionsCall).toContain('exclude=archived');
  });

  it('toggling the archived view requests status=archived and shows Restore', async () => {
    const mockFetch = makeFetch(sessionPayload('archived'));
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Archived');

    // The toggle is labelled "Archived" in the normal view.
    await user.click(screen.getByRole('button', { name: 'Archived' }));

    await waitFor(() => {
      const sessionsCall = mockFetch.mock.calls
        .map(([url]) => url)
        .find((u: string) => u.includes('/api/sessions?'));
      expect(sessionsCall).toContain('status=archived');
      expect(sessionsCall).not.toContain('exclude=archived');
    });

    // The row renders with an "Archived" badge and a Restore button.
    await screen.findByText('Restore');
  });

  it('renders Archive and End actions on processed sessions', async () => {
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End' })).toBeInTheDocument();
  });
});
