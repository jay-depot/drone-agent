import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { WebSocketProvider } from '@/hooks/use-websocket';
import { act, type ReactNode } from 'react';
import SessionDetailPage from './session-detail';

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  url = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/sessions/agent-1']}>
      <AuthProvider>
        <WebSocketProvider>{children}</WebSocketProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
    </Routes>,
    { wrapper }
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const liveSession = {
  id: 'agent-1',
  beaconId: 'b1',
  personaId: null,
  status: 'active',
  interactive: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function makeFetch(options?: { session?: unknown }) {
  let session: unknown = options?.session ?? 'unregistered';
  return {
    setSession(next: unknown) {
      session = next;
    },
    mock: vi.fn().mockImplementation((url: string) => {
      if (url === '/api/sessions/agent-1') {
        if (session === 'unregistered') {
          return Promise.resolve(jsonResponse(404, { error: 'not found' }));
        }
        return Promise.resolve(jsonResponse(200, { session }));
      }
      if (url === '/api/sessions/agent-1/events') {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.resolve(jsonResponse(404, {}));
    }),
  };
}

function sessionFetchCount(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter(([url]) => url === '/api/sessions/agent-1')
    .length;
}

function dispatchWsEvent(
  socket: MockWebSocket,
  eventType: string,
  payload: unknown = {}
) {
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        sessionId: 'agent-1',
        eventType,
        payload,
      }),
    });
  });
}

function lastSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no mock socket was created');
  return socket;
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
  vi.restoreAllMocks();
  // jsdom does not implement scrollIntoView; the page auto-scrolls to the
  // latest event, so the effect throws and unmounts the tree without this.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  // Re-stub per test: afterEach's unstubAllGlobals clears module-level
  // stubs, so a top-level stub would only cover the first test.
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SessionDetailPage live chat', () => {
  it('appends websocket events without crypto.randomUUID (non-secure origin)', async () => {
    // Simulate a plain-HTTP remote origin: crypto.randomUUID is undefined.
    // crypto.randomUUID IS still present in jsdom (Node's secure crypto),
    // so stub the global with a non-secure-context crypto object. If the
    // component regresses to calling crypto.randomUUID(), the WS append
    // throws during setState and this test fails with a blank page.
    const insecureCrypto = {
      getRandomValues: (arr: Uint8Array) => arr,
    } as unknown as Crypto;
    vi.stubGlobal('crypto', insecureCrypto);

    const { mock } = makeFetch();
    vi.stubGlobal('fetch', mock);

    renderPage();
    // Let the initial REST event fetch settle before dispatching, so the
    // fetch's setEvents([]) cannot land after the WS append and clobber it.
    await screen.findByText('No events yet');

    dispatchWsEvent(lastSocket(), 'assistantMessage', 'hello from the agent');

    await waitFor(() => {
      expect(
        screen.getByText('assistantMessage', {
          selector: '[data-slot="badge"]',
        })
      ).toBeInTheDocument();
    });
  });

  it('renders the chat input for live interactive sessions', async () => {
    const { mock } = makeFetch({ session: liveSession });
    vi.stubGlobal('fetch', mock);

    renderPage();

    const input = await screen.findByPlaceholderText(
      'Send a message to this agent…'
    );
    expect(input).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop & Send' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Live — Interactive/)).toBeInTheDocument();
  });

  it('renders no chat input when the session is not interactive', async () => {
    const { mock } = makeFetch({
      session: { ...liveSession, interactive: false },
    });
    vi.stubGlobal('fetch', mock);

    renderPage();

    await screen.findByText('active');
    expect(
      screen.queryByPlaceholderText('Send a message to this agent…')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('renders no chat input when the session is not live', async () => {
    const { mock } = makeFetch({
      session: { ...liveSession, status: 'ended' },
    });
    vi.stubGlobal('fetch', mock);

    renderPage();

    await screen.findByText('ended');
    expect(
      screen.queryByPlaceholderText('Send a message to this agent…')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('refetches session metadata on a session.created websocket event', async () => {
    const fetcher = makeFetch();
    vi.stubGlobal('fetch', fetcher.mock);

    renderPage();

    // Initial fetch 404s — the agent has not registered yet.
    await screen.findByText('No events yet');
    expect(
      screen.queryByPlaceholderText('Send a message to this agent…')
    ).toBeNull();

    // The agent boots and registers: the coordinator publishes
    // session.created and the metadata endpoint now answers 200.
    fetcher.setSession(liveSession);
    dispatchWsEvent(lastSocket(), 'session.created');

    await screen.findByPlaceholderText('Send a message to this agent…');
    expect(
      screen.getByText(/Live — Interactive/, {
        selector: '[data-slot="badge"]',
      })
    ).toBeInTheDocument();
  });

  it('recovers from the initial 404 via bounded timer retry alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = makeFetch();
    vi.stubGlobal('fetch', fetcher.mock);

    renderPage();

    await screen.findByText('No events yet');
    expect(
      screen.queryByPlaceholderText('Send a message to this agent…')
    ).toBeNull();

    // The agent registers a moment later; no websocket event arrives, but
    // the bounded retry picks the session up on its next attempt.
    fetcher.setSession(liveSession);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('Send a message to this agent…')
      ).toBeInTheDocument();
    });

    // Retry is bounded: once the session is fetched, no more polling.
    const countAfterRecovery = sessionFetchCount(fetcher.mock);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(sessionFetchCount(fetcher.mock)).toBe(countAfterRecovery);
  });
});
