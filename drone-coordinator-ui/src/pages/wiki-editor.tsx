import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { WikiPage, CreateWikiPageRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export default function WikiEditorPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const isEdit = !!pageId;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [wikiPageId, setWikiPageId] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState('coordinator');
  const [tags, setTags] = useState('');
  const [sources, setSources] = useState('');

  // Load existing page for edit mode
  useEffect(() => {
    if (!pageId) return;

    async function fetchPage() {
      try {
        const res = await authFetch(`/api/wiki/${pageId}`);
        if (res.ok) {
          const p: WikiPage = await res.json();
          setTitle(p.title);
          setWikiPageId(p.id);
          setContent(p.content);
          setScope(p.scope);
          setTags(p.tags.join(', '));
          setSources(p.sources.join(', '));
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

  // Auto-generate pageId from title on create
  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!isEdit) {
      setWikiPageId(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!content.trim()) {
      setError('Content is required');
      return;
    }

    const targetId = isEdit ? pageId! : wikiPageId.trim();
    if (!targetId) {
      setError('Page ID is required');
      return;
    }

    setSaving(true);
    try {
      const body: CreateWikiPageRequest = {
        title: title.trim(),
        content: content.trim(),
        scope,
        tags: tags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean),
        sources: sources
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      };

      const res = await authFetch(`/api/wiki/${targetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        navigate(`/wiki/${targetId}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to save wiki page');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(pageId ? `/wiki/${pageId}` : '/wiki')}
        >
          ← Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold">
            {isEdit ? 'Edit Wiki Page' : 'New Wiki Page'}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isEdit ? `Editing "${title}"` : 'Create a new wiki page'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium mb-1">
            Title *
          </label>
          <Input
            id="title"
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="My Wiki Page"
          />
        </div>

        {!isEdit && (
          <div>
            <label
              htmlFor="wiki-page-id"
              className="block text-sm font-medium mb-1"
            >
              Page ID
            </label>
            <Input
              id="wiki-page-id"
              value={wikiPageId}
              onChange={e => setWikiPageId(e.target.value)}
              placeholder="my-wiki-page"
            />
            <p className="text-xs text-muted-foreground mt-1">
              URL-safe identifier. Auto-generated from title.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="scope" className="block text-sm font-medium mb-1">
            Scope
          </label>
          <select
            id="scope"
            value={scope}
            onChange={e => setScope(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm bg-background"
          >
            <option value="coordinator">coordinator</option>
          </select>
        </div>

        <div>
          <label htmlFor="tags" className="block text-sm font-medium mb-1">
            Tags
          </label>
          <Input
            id="tags"
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="tag1, tag2, tag3"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Comma-separated list of tags.
          </p>
        </div>

        <div>
          <label htmlFor="sources" className="block text-sm font-medium mb-1">
            Sources
          </label>
          <Input
            id="sources"
            value={sources}
            onChange={e => setSources(e.target.value)}
            placeholder="session-abc123, session-def456"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Comma-separated list of source session IDs.
          </p>
        </div>

        <div>
          <label htmlFor="content" className="block text-sm font-medium mb-1">
            Content *
          </label>
          <textarea
            id="content"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Enter the wiki page content (markdown)..."
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[400px] font-mono"
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Page'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(pageId ? `/wiki/${pageId}` : '/wiki')}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
