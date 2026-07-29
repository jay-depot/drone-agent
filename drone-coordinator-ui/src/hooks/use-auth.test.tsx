import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth, useAuthenticatedFetch } from './use-auth';
import type { ReactNode } from 'react';

// Mock localStorage
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

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it('starts with no token and authenticated', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('setToken stores the token and sets authenticated', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.setToken('test-token');
    });

    expect(result.current.token).toBe('test-token');
    expect(result.current.isAuthenticated).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'drone-coordinator-web-token',
      'test-token'
    );
  });

  it('clearToken removes the token and sets unauthenticated', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.setToken('test-token');
    });

    act(() => {
      result.current.clearToken();
    });

    expect(result.current.token).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('handleUnauthorized sets authenticated to false', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.handleUnauthorized();
    });

    expect(result.current.isAuthenticated).toBe(false);
  });
});

describe('useAuthenticatedFetch', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  it('includes Bearer token in requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Use a single renderHook that accesses both auth and fetch
    const { result } = renderHook(
      () => ({ auth: useAuth(), fetch: useAuthenticatedFetch() }),
      { wrapper }
    );

    act(() => {
      result.current.auth.setToken('test-token');
    });

    await act(async () => {
      await result.current.fetch('/api/test');
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/test', {
      headers: new Headers({
        Authorization: 'Bearer test-token',
      }),
    });
  });

  it('calls handleUnauthorized on 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(
      () => ({ auth: useAuth(), fetch: useAuthenticatedFetch() }),
      { wrapper }
    );

    act(() => {
      result.current.auth.setToken('test-token');
    });

    await act(async () => {
      await result.current.fetch('/api/test');
    });

    expect(result.current.auth.isAuthenticated).toBe(false);
  });
});
