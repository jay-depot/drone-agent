import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { AuthProvider } from '@/hooks/use-auth';
import { useApi, extractApiError } from './use-api';
import type { ReactNode } from 'react';

function jsonResponse(
  status: number,
  body: unknown,
  statusText = ''
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText,
    json: async () => body,
  } as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useApi', () => {
  it('fetches on mount and exposes data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useApi<{ id: string }>('/api/things'), {
      wrapper,
    });

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.data).toEqual({ id: 'x' });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/things');
  });

  it('does not fetch when the url is null', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useApi(null), { wrapper });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the API error body message for non-ok responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: 'No such thing' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useApi('/api/things'), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('No such thing');
    expect(result.current.data).toBeNull();
  });

  it('falls back to HTTP status text when the body has no error message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, {}, 'Internal Server Error'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useApi('/api/things'), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('HTTP 500: Internal Server Error');
  });

  it('surfaces network errors as the error message', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useApi('/api/things'), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('offline');
    expect(result.current.data).toBeNull();
  });

  it('skips the initial fetch when immediate is false and fetches via refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(
      () => useApi<{ id: string }>('/api/things', { immediate: false }),
      { wrapper }
    );

    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toEqual({ id: 'x' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/things');
  });

  it('refetches when the url changes', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(jsonResponse(200, { url }))
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useApi<{ url: string }>(url),
      { wrapper, initialProps: { url: '/api/a' } }
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ url: '/api/a' });
    });

    rerender({ url: '/api/b' });

    await waitFor(() => {
      expect(result.current.data).toEqual({ url: '/api/b' });
    });
    expect(fetchMock.mock.calls.map(([calledUrl]) => calledUrl)).toEqual([
      '/api/a',
      '/api/b',
    ]);
  });
});

describe('extractApiError', () => {
  it('returns the body error message when present', async () => {
    const message = await extractApiError(jsonResponse(409, { error: 'Nope' }));
    expect(message).toBe('Nope');
  });

  it('falls back to HTTP status text when the body has none', async () => {
    const message = await extractApiError(jsonResponse(500, {}, 'Oops'));
    expect(message).toBe('HTTP 500: Oops');
  });

  it("falls back to 'Unknown error' when neither body nor status text is present", async () => {
    const message = await extractApiError(jsonResponse(500, {}));
    expect(message).toBe('HTTP 500: Unknown error');
  });
});
