import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useWikiPages } from '@/hooks/use-wiki-pages';
import { useWikiGraph } from '@/hooks/use-wiki-graph';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import { useWikiFilterState } from '@/hooks/use-wiki-filter-state';
import { useToast } from '@/hooks/use-toast';
import { ErrorBanner } from '@/components/error-banner';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import type { WikiPageMeta } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { paginationRange } from '@/lib/pagination';
import { applyWikiFilters, filtersAreDefault } from '@/lib/wiki-filters';
import { sortWikiPages } from '@/lib/wiki-sort';
import {
  applyNodeSizing,
  buildAugmentedWikiGraph,
} from '@/lib/wiki-graph-utils';
import WikiPageTable from '@/components/wiki-page-table';
import WikiFilterBar from '@/components/wiki-filter-bar';
import WikiGraphView from '@/components/wiki-graph';

const PAGE_SIZE = 25;
// How long typing must settle before a search request fires.
const SEARCH_DEBOUNCE_MS = 350;

export default function WikiPage() {
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphView = searchParams.get('view') === 'graph';
  const focusedNodeId = searchParams.get('node');
  const tagsVisible = searchParams.get('tagnodes') === '1';
  const { pages, setPages, loading, error } = useWikiPages();
  const { filters, sort, setFilters, setSort, clearFilters } =
    useWikiFilterState();
  const { graph, error: graphError } = useWikiGraph(graphView);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<WikiPageMeta[] | null>(
    null
  );
  const [searching, setSearching] = useState(false);
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);

  const setGraphView = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) {
      params.set('view', 'graph');
    } else {
      params.delete('view');
      params.delete('node');
    }
    setSearchParams(params);
  };

  const setFocusedNode = (pageId: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (pageId) {
      params.set('node', pageId);
    } else {
      params.delete('node');
    }
    setSearchParams(params);
  };

  const setTagsVisible = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) {
      params.set('tagnodes', '1');
    } else {
      params.delete('tagnodes');
    }
    setSearchParams(params);
  };

  // Search via API once the query settles; a superseded request is ignored
  // so a slow stale response cannot overwrite a newer one's results. Clearing
  // the box restores the full list (searchResults back to null).
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    let stale = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await authFetch(
          `/api/wiki/search?q=${encodeURIComponent(query)}`
        );
        if (stale) return;
        if (!res.ok) {
          showError(await extractApiError(res));
          return;
        }
        // Search results are { page, snippet, score } wrappers; the table
        // renders page metadata directly.
        const results = await res.json();
        setSearchResults(
          Array.isArray(results)
            ? results.map((r: { page: WikiPageMeta }) => r.page)
            : []
        );
      } catch (err) {
        if (stale) return;
        showError(networkErrorMessage(err));
      } finally {
        if (!stale) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [search, authFetch]);

  const candidates = searchResults ?? pages;

  const filtered = useMemo(
    () => candidates.filter(page => applyWikiFilters(page, filters)),
    [candidates, filters]
  );

  const sorted = useMemo(
    () => (sort.key ? sortWikiPages(filtered, sort.key, sort.dir) : filtered),
    [filtered, sort]
  );

  // Graph dimming set: page-node ids that pass the filters, plus the selected
  // tag nodes. `null` means no filters are active (no dimming).
  const filterActiveIds = useMemo(() => {
    if (filtersAreDefault(filters)) return null;
    const ids = new Set<string>();
    for (const page of pages) {
      if (applyWikiFilters(page, filters)) ids.add(page.id);
    }
    for (const tag of filters.tags) ids.add(`tag:${tag}`);
    return ids;
  }, [pages, filters]);

  const augmented = useMemo(() => {
    if (!graph) return null;
    const base = buildAugmentedWikiGraph(graph);
    return {
      nodes: applyNodeSizing(base.nodes, base.edges),
      edges: base.edges,
    };
  }, [graph]);
  const visible = augmented;
  const focusedNode =
    visible && focusedNodeId
      ? (visible.nodes.find(n => n.id === focusedNodeId) ?? null)
      : null;
  const focusedTagMemberEdges =
    visible && focusedNode?.kind === 'tag'
      ? visible.edges.filter(
          e => e.kind === 'tag' && e.target === focusedNode.id
        )
      : [];
  const memberCount = focusedTagMemberEdges.length;

  const deleteTargetFrom = (page: WikiPageMeta) => {
    setPages(prev => prev.filter(p => p.id !== page.id));
    setSearchResults(prev =>
      prev ? prev.filter(p => p.id !== page.id) : prev
    );
  };

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WikiPageMeta | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const total = sorted.length;
  const paged = sorted.slice(offset, offset + PAGE_SIZE);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(`/api/wiki/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      deleteTargetFrom(deleteTarget);
      setDeleteOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className={graphView ? 'flex h-full min-h-0 flex-col' : undefined}>
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Wiki</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Swarm knowledge base wiki pages
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant={graphView ? 'outline' : 'default'}
            size="sm"
            onClick={() => setGraphView(!graphView)}
            title={graphView ? 'Show wiki as a list' : 'Show wiki as a graph'}
          >
            {graphView ? 'List' : 'Graph'}
          </Button>
          {graphView && (
            <Button
              variant={tagsVisible ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => setTagsVisible(!tagsVisible)}
              title="Show tag nodes. Tag nodes also organize the layout when hidden."
            >
              Tags
            </Button>
          )}
          {!graphView && (
            <Button onClick={() => navigate('/wiki/new')}>New Page</Button>
          )}
        </div>
      </div>

      <WikiFilterBar
        filters={filters}
        onChange={setFilters}
        onClear={clearFilters}
        pages={pages}
      />

      <ErrorBanner message={error} />

      <ErrorBanner message={graphError} />

      {graphView ? (
        <div className="relative flex flex-1 min-h-0">
          {focusedNode && (
            <aside className="absolute left-4 top-4 z-20 w-80 rounded-md border p-4 bg-card shadow-lg">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{focusedNode.title}</h2>
                  {focusedNode.kind === 'page' ? (
                    <p className="text-xs text-muted-foreground font-mono">
                      {focusedNode.id}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Tag · {memberCount} page(s)
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFocusedNode(null)}
                >
                  Show all
                </Button>
                {focusedNode.kind === 'page' && (
                  <Button
                    size="sm"
                    onClick={() => navigate(`/wiki/${focusedNode.id}`)}
                  >
                    Open full page
                  </Button>
                )}
              </div>
              {focusedNode.kind !== 'tag' && (
                <>
                  {focusedNode.pitch && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {focusedNode.pitch}
                    </p>
                  )}
                  {focusedNode.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-3">
                      {focusedNode.tags.map(tag => (
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
                </>
              )}
            </aside>
          )}
          <WikiGraphView
            nodes={visible?.nodes ?? []}
            edges={visible?.edges ?? []}
            tagsVisible={tagsVisible}
            focusedNodeId={focusedNodeId}
            filterActiveIds={filterActiveIds}
            onNodeFocus={setFocusedNode}
            onClearFocus={() => setFocusedNode(null)}
          />
        </div>
      ) : (
        <>
          {/* Search */}
          <div className="mb-4 flex items-center gap-3">
            <Input
              className="max-w-md"
              placeholder="Search wiki pages..."
              value={search}
              onChange={e => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
            {searchResults !== null && sort.key === null && (
              <span className="text-xs text-muted-foreground">
                Sorted by relevance
              </span>
            )}
          </div>

          {loading || searching ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map(i => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : paged.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-lg">
                {search
                  ? 'No wiki pages match your search'
                  : filtersAreDefault(filters)
                    ? 'No wiki pages yet'
                    : 'No wiki pages match these filters'}
              </p>
              <p className="text-sm mt-1">
                {search
                  ? 'Try a different search term.'
                  : filtersAreDefault(filters)
                    ? 'Wiki pages are built from session logs and shared knowledge across the swarm.'
                    : 'Adjust or clear the filters to see more.'}
              </p>
            </div>
          ) : (
            <>
              <WikiPageTable
                pages={paged}
                sortKey={sort.key}
                sortDir={sort.dir}
                onSort={setSort}
                onDelete={wikiPage => {
                  setDeleteTarget(wikiPage);
                  setDeleteOpen(true);
                }}
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
