import {
  useState,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { WikiPageMeta } from '@/lib/types';

/**
 * Fetch the full wiki page list from the coordinator.
 * Exposes `setPages` so callers can apply search results and deletes.
 */
export function useWikiPages(): {
  pages: WikiPageMeta[];
  setPages: Dispatch<SetStateAction<WikiPageMeta[]>>;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const authFetch = useAuthenticatedFetch();
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/wiki');
      if (res.ok) {
        setPages(await res.json());
      }
    } catch {
      setError('Failed to load wiki pages');
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    fetchPages();
  }, [fetchPages]);

  return { pages, setPages, loading, error, refetch: fetchPages };
}
