import { useNavigate, Link } from 'react-router-dom';
import type { WikiPageMeta } from '@/lib/types';
import type { SortDir, WikiSortKey } from '@/lib/wiki-sort';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const MAX_VISIBLE_TAGS = 3;

type SortableColumn = { key: WikiSortKey; label: string };

const COLUMNS: (SortableColumn | { key: null; label: string })[] = [
  { key: 'title', label: 'Title' },
  { key: null, label: 'Tags' },
  { key: 'created', label: 'Created' },
  { key: 'updated', label: 'Updated' },
  { key: 'words', label: 'Word Count' },
  { key: 'sources', label: 'Source Sessions' },
];

function sortIndicator(
  key: WikiSortKey,
  activeKey: WikiSortKey | null,
  dir: SortDir
): string {
  if (activeKey !== key) return '';
  return dir === 'asc' ? '▲' : '▼';
}

export default function WikiPageTable({
  pages,
  sortKey,
  sortDir,
  onSort,
  onDelete,
}: {
  pages: WikiPageMeta[];
  sortKey: WikiSortKey | null;
  sortDir: SortDir;
  onSort?: (key: WikiSortKey) => void;
  onDelete?: (page: WikiPageMeta) => void;
}) {
  const navigate = useNavigate();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map(column => (
            <TableHead key={column.label}>
              {column.key === null ? (
                column.label
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => onSort?.(column.key as WikiSortKey)}
                >
                  {column.label}
                  <span className="text-[0.7em]">
                    {sortIndicator(column.key, sortKey, sortDir)}
                  </span>
                </button>
              )}
            </TableHead>
          ))}
          {onDelete && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {pages.map(page => (
          <TableRow
            key={page.id}
            className="cursor-pointer"
            onClick={() => navigate(`/wiki/${page.id}`)}
          >
            <TableCell className="font-medium">{page.title}</TableCell>
            <TableCell>
              <div
                className="flex flex-wrap items-center gap-1"
                title={page.tags.join(', ')}
              >
                {page.tags.slice(0, MAX_VISIBLE_TAGS).map(tag => (
                  <Link
                    key={tag}
                    to={`/wiki/tag/${tag}`}
                    onClick={e => e.stopPropagation()}
                  >
                    <Badge variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  </Link>
                ))}
                {page.tags.length > MAX_VISIBLE_TAGS && (
                  <Badge variant="outline" className="text-xs">
                    +{page.tags.length - MAX_VISIBLE_TAGS}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(page.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(page.updatedAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {page.wordCount}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              <span title={page.sources.join(', ')}>{page.sources.length}</span>
            </TableCell>
            {onDelete && (
              <TableCell className="text-right">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(page);
                  }}
                >
                  Delete
                </Button>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
