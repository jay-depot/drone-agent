import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { WikiPageMeta } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function WikiPage() {
  const authFetch = useAuthenticatedFetch();
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchWiki() {
      try {
        const res = await authFetch('/wiki');
        if (res.ok) {
          setPages(await res.json());
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }
    }
    fetchWiki();
  }, [authFetch]);

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Wiki</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Wiki</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Swarm knowledge base wiki pages
      </p>

      {pages.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No wiki pages yet</p>
          <p className="text-sm mt-1">
            Wiki pages are built from session logs and shared knowledge across
            the swarm.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {pages.map(page => (
            <Card key={page.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{page.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>ID</span>
                    <span className="font-mono">{page.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Scope</span>
                    <Badge variant="outline" className="text-xs">
                      {page.scope}
                    </Badge>
                  </div>
                  {page.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {page.tags.map(tag => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="text-xs"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-between pt-1">
                    <span>Updated</span>
                    <span>{new Date(page.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
