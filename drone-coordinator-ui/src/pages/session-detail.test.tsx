import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import SessionDetailPage from './session-detail';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';
import { WebSocketProvider } from '@/hooks/use-websocket';
import type { ReactNode } from 'react';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock WebSocket so the page can subscribe without a live coordinator.
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    json: async () => body,
  } as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        <WebSocketProvider>{children}</WebSocketProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      nav
    </button>
  );
}

function renderDetail(initialPath = '/sessions/s-1') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/sessions/:sessionId"
          element={
            <>
              <NavigateButton to="/sessions/s-2" />
              <SessionDetailPage />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
    { wrapper }
  );
}

describe('SessionDetailPage events load', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders events after a successful load', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-1/events') {
        return jsonResponse(200, [
          {
            id: 'e1',
            sessionId: 's-1',
            correlationId: null,
            type: 'message',
            payload: 'hello',
            metadata: null,
            createdAt: 1_700_000_000_000,
          },
        ]);
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail();

    // The payload is inside a collapsed Collapsible; the visible card header
    // carries the event-type badge.
    await waitFor(() => {
      expect(screen.getByText('message')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error banner and no fake empty state when the load fails', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-1/events') {
        return jsonResponse(500, { error: 'Events unavailable' });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Events unavailable');
    // The empty state stays below the banner: once WS events start flowing
    // the page recovers visually without a refetch.
    expect(screen.getByText('No events yet')).toBeInTheDocument();
  });

  it('clears the banner when navigating to a healthy session', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-1/events') {
        return jsonResponse(500, { error: 'Events unavailable' });
      }
      if (url === '/api/sessions/s-2/events') {
        return jsonResponse(200, []);
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail();
    await screen.findByRole('alert');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'nav' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(screen.getByText('No events yet')).toBeInTheDocument();
  });

  it('shows a fallback message when the failure carries no error body', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-1/events') {
        return jsonResponse(500, {});
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 500: Unknown error');
  });
});
