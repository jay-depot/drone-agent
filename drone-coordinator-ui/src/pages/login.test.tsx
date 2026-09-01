import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from './login';
import { AuthProvider } from '@/hooks/use-auth';

// localStorage stub (jsdom has a working localStorage, but stubbing keeps the
// assertions explicit and matches the use-auth test patterns).
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

function renderLogin() {
  return render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>
  );
}

async function submitToken(value: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Paste your access token...'), value);
  await user.click(screen.getByRole('button', { name: 'Connect' }));
}

describe('LoginPage token validation', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a 401 response at the gate without storing the token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 401, ok: false });
    vi.stubGlobal('fetch', mockFetch);

    renderLogin();
    await submitToken('garbage');

    await waitFor(() => {
      expect(screen.getByText('Invalid token. Please try again.')).toBeTruthy();
    });
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/personas',
      expect.objectContaining({
        headers: { Authorization: 'Bearer garbage' },
      })
    );
  });

  it('stores the token and proceeds on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', mockFetch);

    renderLogin();
    await submitToken('good-token');

    await waitFor(() => {
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'drone-coordinator-web-token',
        'good-token'
      );
    });
  });

  it('falls back permissively on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', mockFetch);

    renderLogin();
    await submitToken('any-token');

    await waitFor(() => {
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'drone-coordinator-web-token',
        'any-token'
      );
    });
  });

  it('falls back permissively on non-401 failure statuses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 429, ok: false });
    vi.stubGlobal('fetch', mockFetch);

    renderLogin();
    await submitToken('any-token');

    await waitFor(() => {
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'drone-coordinator-web-token',
        'any-token'
      );
    });
  });

  it('validates against a protected endpoint rather than /health', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', mockFetch);

    renderLogin();
    await submitToken('good-token');

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/personas');
  });
});