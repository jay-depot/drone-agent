import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { ErrorBanner } from '@/components/error-banner';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import type { SwarmFragment } from '@/lib/types';
import {
  BROADCAST_TARGET,
  MAX_FRAGMENT_CONTENT_BYTES,
  SWARM_IDENTITY_FRAGMENT_ID,
} from '@/lib/fragments';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export default function IdentityPage() {
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [hasRow, setHasRow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [clearOpen, setClearOpen] = useState(false);

  useEffect(() => {
    async function fetchIdentity() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(
          `/api/fragments?target=${BROADCAST_TARGET}`
        );
        if (!res.ok) {
          setError(await extractApiError(res));
          return;
        }
        const body = (await res.json()) as { fragments: SwarmFragment[] };
        const identity = body.fragments.find(
          f => f.id === SWARM_IDENTITY_FRAGMENT_ID
        );
        setContent(identity?.content ?? '');
        setSavedContent(identity?.content ?? '');
        setHasRow(identity !== undefined);
      } catch (err) {
        setError(networkErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    fetchIdentity();
  }, [authFetch]);

  const byteLength = new TextEncoder().encode(content).length;
  const overLimit = byteLength > MAX_FRAGMENT_CONTENT_BYTES;
  const unchanged = content === savedContent;
  const trimmed = content.trim();
  const saveDisabled = saving || unchanged || trimmed === '' || overLimit;

  const handleSave = async () => {
    if (saveDisabled) return;
    setSaving(true);
    try {
      const res = await authFetch(
        `/api/fragments/${SWARM_IDENTITY_FRAGMENT_ID}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: BROADCAST_TARGET,
            content,
            phase: 'header',
          }),
        }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setSavedContent(content);
      setHasRow(true);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const res = await authFetch(
        `/api/fragments/${SWARM_IDENTITY_FRAGMENT_ID}?target=${BROADCAST_TARGET}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setContent('');
      setSavedContent('');
      setHasRow(false);
      setClearOpen(false);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Identity</h1>
          <p className="text-muted-foreground text-sm mt-1">
            A shared description of this swarm, injected into every agent's
            system prompt
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="destructive"
            onClick={() => setClearOpen(true)}
            disabled={loading || !hasRow || clearing}
          >
            Clear
          </Button>
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <div
        className="mb-4 p-3 rounded-md bg-muted text-muted-foreground text-sm"
        role="note"
      >
        This text is broadcast to all agents and rendered as a{' '}
        <code># Swarm Identity</code> section in their system prompt. Each agent
        also renders a <code># Swarm Status</code> section (local beacon,
        coordinator, registered beacons) automatically.
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <div className="space-y-3">
          <div className="h-48 w-full rounded-lg bg-muted animate-pulse" />
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            className="w-full h-64 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={
              'Describe this swarm: what it is for, who it serves, how its agents should behave. This is injected into every agent as `# Swarm Identity`.'
            }
          />
          <div
            className={`text-xs text-right ${
              overLimit ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {byteLength} / {MAX_FRAGMENT_CONTENT_BYTES} bytes
          </div>
        </div>
      )}

      <Dialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={handleClear}
        title="Clear Swarm Identity"
        description="This removes the swarm identity. Agents will stop rendering a # Swarm Identity section. This action cannot be undone."
        confirmLabel="Clear"
        variant="destructive"
        loading={clearing}
      />
    </div>
  );
}
