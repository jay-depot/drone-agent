import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import { useWikiFilterState } from '@/hooks/use-wiki-filter-state';
import type { WikiPageMeta } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { paginationRange } from '@/lib/pagination';
import { sortWikiPages } from '@/lib/wiki-sort';
import { ErrorBanner } from '@/components/error-banner';
import WikiPageTable from '@/components/wiki-page-table';

const PAGE_SIZE = 25;

export default function WikiTagPage() {
  const { tag = '' } = useParams<{ tag: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { sort, setSort } = useWikiFilterState();
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;

    async function fetchTaggedPages() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`/api/wiki?tag=${encodeURIComponent(tag)}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setPages(data);
        }
      } catch {
        if (!cancelled) setError('Failed to load wiki pages');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTaggedPages();
    return () => {
      cancelled = true;
    };
  }, [tag, authFetch]);

  const sorted = useMemo(
    () => (sort.key ? sortWikiPages(pages, sort.key, sort.dir) : pages),
    [pages, sort]
  );

  const total = sorted.length;
  const paged = sorted.slice(offset, offset + PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          ← Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Tag: {tag}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {total} page{total === 1 ? '' : 's'} tagged with "{tag}"
          </p>
        </div>
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No wiki pages tagged with "{tag}"</p>
        </div>
      ) : (
        <>
          <WikiPageTable
            pages={paged}
            sortKey={sort.key}
            sortDir={sort.dir}
            onSort={setSort}
          />

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Showing {paginationRange(offset, PAGE_SIZE, total)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(offset - PAGE_SIZE)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
