import { useState, useEffect, useCallback } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { WikiGraph } from '@/lib/types';

/**
 * Fetch the wiki connected-graph (nodes + edges) from the coordinator.
 * Exposes refetch so callers can refresh after edits/deletes.
 */
export function useWikiGraph(enabled?: boolean): {
  graph: WikiGraph | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const authFetch = useAuthenticatedFetch();
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = enabled ?? true;

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/wiki/graph');
      if (res.ok) {
        setGraph(await res.json());
      } else {
        setError('Failed to load wiki graph');
      }
    } catch {
      setError('Failed to load wiki graph');
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    if (active) {
      fetchGraph();
    }
  }, [fetchGraph, active]);

  return { graph, loading, error, refetch: fetchGraph };
}
