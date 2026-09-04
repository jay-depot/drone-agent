import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import SessionsPage from './sessions';
import { act, type ReactNode } from 'react';

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

function lastSessionsCall(
  mockFetch: ReturnType<typeof vi.fn>
): string | undefined {
  return mockFetch.mock.calls
    .map(([url]) => url as string)
    .filter(u => u.includes('/api/sessions?'))
    .at(-1);
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
    const sessionsCall = lastSessionsCall(mockFetch);
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
      const sessionsCall = lastSessionsCall(mockFetch);
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

describe('SessionsPage archive actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
      if (url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse(200, {}));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
  }

  it('archive executes directly without a confirmation dialog', async () => {
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    // The archive request fires immediately (no dialog prompt first).
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            url === '/api/sessions/s-1/archive' &&
            (init as RequestInit).method === 'POST'
        )
      ).toBe(true);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a phantom row with an Undo button after archiving', async () => {
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    // The phantom row appears immediately with an Undo button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });
    // The normal session row is gone (archived out of the list).
    await screen.findByText('Undo');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('undo restores the archived session', async () => {
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            url === '/api/sessions/s-1/restore' &&
            (init as RequestInit).method === 'POST'
        )
      ).toBe(true);
    });
    // The phantom row disappears after undo is clicked.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('phantom row disappears after the archive undo window', async () => {
    // shouldAdvanceTime lets user-event and the setTimeout-based findBy helpers
    // run under fake timers instead of hanging, while we still fast-forward the
    // phantom undo window explicitly.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockFetch = makeFetch(sessionPayload('processed'));
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('Processed');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    // Fast-forward past the 5s undo window so the phantom row clears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });
  });
});
