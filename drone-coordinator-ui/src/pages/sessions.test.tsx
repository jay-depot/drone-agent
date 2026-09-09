import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import { ToastProvider } from '@/hooks/use-toast';
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

// Scripted list responses: each entry is the body returned by one successive
// GET /api/sessions? call. The final entry repeats for any further calls.
function scriptedFetch(
  listResponses: unknown[],
  actionFailures?: {
    archive?: number;
    restore?: number;
  }
) {
  let listCallIndex = 0;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/api/sessions?')) {
      const index = Math.min(listCallIndex, listResponses.length - 1);
      listCallIndex++;
      return Promise.resolve(jsonResponse(200, listResponses[index]));
    }
    if (url === '/api/beacons') {
      return Promise.resolve(jsonResponse(200, []));
    }
    if (method === 'POST' && url.includes('/api/sessions/')) {
      if (url.endsWith('/archive') && actionFailures?.archive) {
        return Promise.resolve(jsonResponse(actionFailures.archive, {}));
      }
      if (url.endsWith('/restore') && actionFailures?.restore) {
        return Promise.resolve(jsonResponse(actionFailures.restore, {}));
      }
      return Promise.resolve(jsonResponse(200, {}));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
}

const listBody = (sessions: unknown[], count = sessions.length) => ({
  sessions,
  count,
});

describe('SessionsPage archive view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('default view requests exclude=archived', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])]);
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
    const mockFetch = scriptedFetch([listBody([sessionPayload('archived')])]);
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
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])]);
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

  it('archive executes directly without a confirmation dialog', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])]);
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

  it('shows an in-place pending row with an Undo button after archiving', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])]);
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

    // The pending row appears immediately with an Undo button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });
    // The row keeps its place in the list (no phantom top-row): the only
    // agent-id text in the document is the still-present session row.
    expect(screen.getByText('s-1')).toBeInTheDocument();
    // The row's action buttons are replaced by Undo only.
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Peek' })).toBeNull();
  });

  it('undo restores the archived session and refetches', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])]);
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
    // The undo refetches the current page so the restored row returns.
    await waitFor(() => {
      expect(lastSessionsCall(mockFetch)).toBeTruthy();
      expect(
        mockFetch.mock.calls.filter(([url]) =>
          String(url).includes('/api/sessions?')
        ).length
      ).toBeGreaterThan(1);
    });
    await screen.findByText('Processed');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('pending row disappears and the next row loads after the undo window', async () => {
    // shouldAdvanceTime lets user-event and the findBy helpers run under fake
    // timers while we fast-forward the undo window explicitly.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = { ...sessionPayload('processed', 's-1'), createdAt: 3000 };
    const next = { ...sessionPayload('processed', 's-2'), createdAt: 200 };
    const mockFetch = scriptedFetch([listBody([first]), listBody([next])]);
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('s-1');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    // Fast-forward past the 5s undo window; the expiry refetch returns the
    // next row, which fills the slot the pending row vacated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });

    await screen.findByText('s-2');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByText('Processed')).toBeInTheDocument();
  });

  it('a second archive leaves earlier undo rows intact', async () => {
    const s1 = { ...sessionPayload('processed', 's-1'), createdAt: 3000 };
    const s2 = { ...sessionPayload('processed', 's-2'), createdAt: 2000 };
    const mockFetch = scriptedFetch([listBody([s1, s2])]);
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('s-1');
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    // Archive the remaining processed row; both rows must now be pending.
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Peek' })).toBeNull();
  });

  it('pending rows keep their list position', async () => {
    const rows = [
      { ...sessionPayload('processed', 's-top'), createdAt: 3000 },
      { ...sessionPayload('processed', 's-mid'), createdAt: 2000 },
      { ...sessionPayload('processed', 's-low'), createdAt: 1000 },
    ];
    const mockFetch = scriptedFetch([listBody(rows)]);
    vi.stubGlobal('fetch', mockFetch);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionsPage />
      </MemoryRouter>,
      { wrapper }
    );

    await screen.findByText('s-top');
    // Archive the middle row; its Archive button is the second in DOM order.
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[1]);

    // The archived (pending) row must still render between its neighbours.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });
    // Row order in the table body: header row first, then the three data
    // rows in their original order — the archived row stays in the middle.
    const dataRows = screen
      .getAllByRole('row')
      .slice(1)
      .map(row => row.textContent ?? '');
    expect(
      ['s-top', 's-mid', 's-low'].map(id =>
        dataRows.findIndex(text => text.includes(id))
      )
    ).toEqual([0, 1, 2]);
  });

  it('failed archive shows an error toast and keeps the row', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])], {
      archive: 500,
    });
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
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to archive session'
      );
    });
    // The row is untouched: normal actions remain, no Undo appears.
    expect(screen.getByText('s-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('failed undo shows an error toast and refetches', async () => {
    const mockFetch = scriptedFetch([listBody([sessionPayload('processed')])], {
      restore: 409,
    });
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
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to restore session'
      );
    });
    // The undo refetches the page even when restore failed.
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.filter(([url]) =>
          String(url).includes('/api/sessions?')
        ).length
      ).toBeGreaterThan(1);
    });
  });
});
