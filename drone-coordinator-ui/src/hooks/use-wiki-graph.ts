import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useWebSocket } from '@/hooks/use-websocket';
import type { WikiGraph } from '@/lib/types';

/** Refetch at most this often when wiki.changed events arrive in a burst. */
const WIKI_CHANGED_DEBOUNCE_MS = 500;

/**
 * Fetch the wiki connected-graph (nodes + edges) from the coordinator.
 * Exposes refetch so callers can refresh after edits/deletes. Also refetches
 * (debounced) when the coordinator announces wiki changes over the WebSocket,
 * so the graph stays live while agents write pages.
 */
export function useWikiGraph(enabled?: boolean): {
  graph: WikiGraph | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const authFetch = useAuthenticatedFetch();
  const { subscribe } = useWebSocket();
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

  // Live updates: wiki.changed events (agent-driven page writes, deletes)
  // trigger a debounced refetch so bursts collapse into one fetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribe('wiki.changed', () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchGraph();
      }, WIKI_CHANGED_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [active, subscribe, fetchGraph]);

  return { graph, loading, error, refetch: fetchGraph };
}
