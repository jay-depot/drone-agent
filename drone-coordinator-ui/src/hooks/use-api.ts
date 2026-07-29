import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthenticatedFetch } from './use-auth';

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
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
  const urlRef = useRef(url);

  const fetchData = useCallback(async () => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setState({
          data: null,
          loading: false,
          error: body.error || `HTTP ${res.status}: ${res.statusText}`,
        });
        return;
      }
      const data = (await res.json()) as T;
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : 'Network error',
      });
    }
  }, [url, authFetch]);

  useEffect(() => {
    if (urlRef.current !== url) {
      urlRef.current = url;
      if (options?.immediate ?? true) {
        fetchData();
      }
    }
  }, [url, fetchData, options?.immediate]);

  return { ...state, refetch: fetchData };
}
