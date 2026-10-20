import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PreApprovalTokensPage from './pre-approval-tokens';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';

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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function renderPage() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/pre-approval-tokens']}>
          <Routes>
            <Route
              path="/pre-approval-tokens"
              element={<PreApprovalTokensPage />}
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

const entry = {
  durableId: 'durable-1',
  label: 'gateway on the pi',
  issuedAt: 1000,
  expiresAt: Date.now() + 100000,
  burnedAt: null,
  burnedBy: null,
};

const issuedToken = {
  durableId: 'durable-1',
  pubKey: 'pub-key',
  tlsFingerprint: 'fp',
  burnKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  sig: 'sig',
};

describe('PreApprovalTokensPage', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) =>
      handler(url, init)
    );
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('renders the token list', async () => {
    stubFetch((url, init) => {
      if (
        url === '/api/pre-approval-tokens' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, [entry]);
      }
      return jsonResponse(404, { error: 'unexpected' });
    });

    renderPage();
    expect(await screen.findByText('gateway on the pi')).toBeInTheDocument();
    expect(screen.getByText('durable-1')).toBeInTheDocument();
    expect(screen.getByText('unused')).toBeInTheDocument();
  });

  it('shows the token box and warning after creating', async () => {
    stubFetch((url, init) => {
      if (
        url === '/api/pre-approval-tokens' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, []);
      }
      if (url === '/api/pre-approval-tokens' && init?.method === 'POST') {
        return jsonResponse(201, { token: issuedToken, entry });
      }
      return jsonResponse(404, { error: 'unexpected' });
    });

    renderPage();
    await screen.findByText('No tokens yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByText('New token (shown once)')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/This token is a sensitive credential/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Download' })
    ).toBeInTheDocument();
  });

  it('copies the token to the clipboard', async () => {
    stubFetch((url, init) => {
      if (
        url === '/api/pre-approval-tokens' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, []);
      }
      if (url === '/api/pre-approval-tokens' && init?.method === 'POST') {
        return jsonResponse(201, { token: issuedToken, entry });
      }
      return jsonResponse(404, { error: 'unexpected' });
    });

    renderPage();
    await screen.findByText('No tokens yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByRole('button', { name: 'Copy' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
  });

  it('revokes a token', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (
        url === '/api/pre-approval-tokens' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, [entry]);
      }
      if (
        url === '/api/pre-approval-tokens/durable-1' &&
        init?.method === 'DELETE'
      ) {
        return jsonResponse(200, { revoked: true });
      }
      return jsonResponse(404, { error: 'unexpected' });
    });

    renderPage();
    await screen.findByText('gateway on the pi');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    const dialog = await screen.findByRole('dialog');
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    await userEvent.click(revokeButtons[revokeButtons.length - 1]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/pre-approval-tokens/durable-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
    void dialog;
  });

  it('renders the route without a sidebar nav item', async () => {
    stubFetch(() => jsonResponse(200, []));
    render(
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={['/pre-approval-tokens']}>
            <Routes>
              <Route
                path="/pre-approval-tokens"
                element={<PreApprovalTokensPage />}
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    );
    await screen.findByText('Pre-approval tokens');
    expect(
      screen.queryByRole('link', { name: 'Pre-approval tokens' })
    ).not.toBeInTheDocument();
  });
});
