import { useState, useEffect, useCallback } from 'react';
import { useAuthenticatedFetch } from './use-auth';

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Normalize a non-ok API response into a human-readable message: the JSON
 * body's `error` field when present, falling back to HTTP status text.
 */
export async function extractApiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({ error: res.statusText }));
  return (
    body.error || `HTTP ${res.status}: ${res.statusText || 'Unknown error'}`
  );
}

/** Normalize a thrown fetch error into a human-readable message. */
export function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Network error';
}

interface UseApiResult<T> extends UseApiState<T> {
  refetch: () => Promise<void>;
}

/**
 * Reusable hook for fetching data from the coordinator API.
 * Tracks loading, error, and data states consistently.
 * Automatically refetches when the url changes.
 */
export function useApi<T = unknown>(
  url: string | null,
  options?: { immediate?: boolean }
): UseApiResult<T> {
  const authFetch = useAuthenticatedFetch();
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: (options?.immediate ?? true) && url !== null,
    error: null,
  });

  const fetchData = useCallback(async () => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const error = await extractApiError(res);
        setState({ data: null, loading: false, error });
        return;
      }
      const data = (await res.json()) as T;
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: networkErrorMessage(err) });
    }
  }, [url, authFetch]);

  useEffect(() => {
    if (options?.immediate ?? true) {
      fetchData();
    }
  }, [url, fetchData, options?.immediate]);

  return { ...state, refetch: fetchData };
}
