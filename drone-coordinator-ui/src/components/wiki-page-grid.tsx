import { useNavigate, Link } from 'react-router-dom';
import type { WikiPageMeta } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function WikiPageGrid({
  pages,
  onDelete,
}: {
  pages: WikiPageMeta[];
  onDelete?: (page: WikiPageMeta) => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {pages.map(wikiPage => (
        <Card
          key={wikiPage.id}
          className="cursor-pointer hover:ring-2 hover:ring-ring/50 transition-all"
          onClick={() => navigate(`/wiki/${wikiPage.id}`)}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{wikiPage.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>ID</span>
                <span className="font-mono">{wikiPage.id}</span>
              </div>
              <div className="flex justify-between">
                <span>Scope</span>
                <Badge variant="outline" className="text-xs">
                  {wikiPage.scope}
                </Badge>
              </div>
              {wikiPage.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {wikiPage.tags.map(tag => (
                    <Link key={tag} to={`/wiki/tag/${tag}`}>
                      <Badge variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
              <div className="flex justify-between pt-1">
                <span>Updated</span>
                <span>{new Date(wikiPage.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
            {onDelete && (
              <div
                className="mt-3 pt-3 border-t"
                onClick={e => e.stopPropagation()}
              >
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onDelete(wikiPage)}
                >
                  Delete
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
