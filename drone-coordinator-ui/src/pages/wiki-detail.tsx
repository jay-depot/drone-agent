import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { WikiPage } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function WikiDetailPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const [page, setPage] = useState<WikiPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (!pageId) return;

    async function fetchPage() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`/api/wiki/${pageId}`);
        if (res.ok) {
          setPage(await res.json());
        } else {
          setError('Wiki page not found');
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load wiki page'
        );
      } finally {
        setLoading(false);
      }
    }
    fetchPage();
  }, [pageId, authFetch]);

  const handleDelete = async () => {
    if (!pageId) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(`/api/wiki/${pageId}`, { method: 'DELETE' });
      if (res.ok) {
        navigate('/wiki');
      }
    } catch {
      // Error handled silently
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!pageId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No page ID provided.
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/wiki')}>
            ← Back
          </Button>
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/wiki')}>
            ← Back
          </Button>
        </div>
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">{error || 'Wiki page not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/wiki')}>
          ← Back
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{page.title}</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono">
            {page.id}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(`/wiki/${pageId}/edit`)}
          >
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Scope</span>
              <p className="mt-0.5">
                <Badge variant="outline" className="text-xs">
                  {page.scope}
                </Badge>
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <p className="mt-0.5">
                {new Date(page.createdAt).toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Updated</span>
              <p className="mt-0.5">
                {new Date(page.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>

          {page.tags.length > 0 && (
            <div className="mt-3">
              <span className="text-sm text-muted-foreground">Tags</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {page.tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {page.sources.length > 0 && (
            <div className="mt-3">
              <span className="text-sm text-muted-foreground">Sources</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {page.sources.map(source => (
                  <Badge key={source} variant="outline" className="text-xs">
                    {source}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Content</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-sm bg-muted p-4 rounded-md overflow-x-auto whitespace-pre-wrap font-mono">
            {page.content}
          </pre>
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete Wiki Page"
        description={`Are you sure you want to delete "${page.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteLoading}
      />
    </div>
  );
}
