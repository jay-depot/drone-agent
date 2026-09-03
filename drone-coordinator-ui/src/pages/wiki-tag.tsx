import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWikiPages } from '@/hooks/use-wiki-pages';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { paginationRange } from '@/lib/pagination';
import WikiPageGrid from '@/components/wiki-page-grid';

const PAGE_SIZE = 12;

export default function WikiTagPage() {
  const { tag = '' } = useParams<{ tag: string }>();
  const navigate = useNavigate();
  const { pages, loading, error } = useWikiPages();
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);

  const tagged = useMemo(
    () => pages.filter(p => p.tags.includes(tag)),
    [pages, tag]
  );

  const total = tagged.length;
  const paged = tagged.slice(offset, offset + PAGE_SIZE);

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

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="rounded-xl ring-1 ring-foreground/10 p-4">
              <Skeleton className="h-5 w-32 mb-2" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No wiki pages tagged with "{tag}"</p>
        </div>
      ) : (
        <>
          <WikiPageGrid pages={paged} />

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
