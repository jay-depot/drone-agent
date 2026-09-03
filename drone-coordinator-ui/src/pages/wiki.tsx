import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useWikiPages } from '@/hooks/use-wiki-pages';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import type { WikiPageMeta } from '@/lib/types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { paginationRange } from '@/lib/pagination';
import WikiPageGrid from '@/components/wiki-page-grid';

const PAGE_SIZE = 12;

export default function WikiPage() {
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const { pages, setPages, loading, error } = useWikiPages();
  const [search, setSearch] = useState('');
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WikiPageMeta | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Search via API when query changes
  useEffect(() => {
    if (!search.trim()) return;

    async function searchWiki() {
      try {
        const res = await authFetch(
          `/api/wiki/search?q=${encodeURIComponent(search)}`
        );
        if (res.ok) {
          // Search results are { page, snippet, score } wrappers; the card
          // grid renders page metadata directly.
          const results = await res.json();
          setPages(
            Array.isArray(results)
              ? results.map((r: { page: WikiPageMeta }) => r.page)
              : []
          );
        }
      } catch {
        // Fall back to current list
      }
    }
    searchWiki();
  }, [search, authFetch]);

  const total = pages.length;
  const paged = pages.slice(offset, offset + PAGE_SIZE);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(`/api/wiki/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setPages(prev => prev.filter(p => p.id !== deleteTarget.id));
        setDeleteOpen(false);
        setDeleteTarget(null);
      }
    } catch {
      // Error handled silently
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Wiki</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Swarm knowledge base wiki pages
          </p>
        </div>
        <Button onClick={() => navigate('/wiki/new')}>New Page</Button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <Input
          placeholder="Search wiki pages..."
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">
            {search ? 'No wiki pages match your search' : 'No wiki pages yet'}
          </p>
          <p className="text-sm mt-1">
            {search
              ? 'Try a different search term.'
              : 'Wiki pages are built from session logs and shared knowledge across the swarm.'}
          </p>
        </div>
      ) : (
        <>
          <WikiPageGrid
            pages={paged}
            onDelete={wikiPage => {
              setDeleteTarget(wikiPage);
              setDeleteOpen(true);
            }}
          />

          {/* Pagination */}
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

      {/* Delete Confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleDelete}
        title="Delete Wiki Page"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.title}"? This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteLoading}
      />
    </div>
  );
}
