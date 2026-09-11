import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { ErrorBanner } from '@/components/error-banner';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import type { CoordinatorConfigEntry } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const ALLOWLIST_PATTERNS = [
  'providers.*',
  'llm.active',
  'llm.reasoningLevel',
  'compaction.enabled',
  'compaction.strategy',
  'session.guardrail.*',
];

/** Show a masked preview: `••••` + last 4 chars for the full stored value. */
function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return '••••';
  }
  return `••••${trimmed.slice(-4)}`;
}

/** Truncate a long non-secret value preview to ~60 chars. */
function previewValue(entry: CoordinatorConfigEntry): string {
  if (entry.secret) {
    return maskValue(entry.value);
  }
  const single = entry.value.replace(/\s+/g, ' ');
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

function formatUpdated(updatedAt: number): string {
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return '';
  }
}

export default function ConfigPage() {
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [entries, setEntries] = useState<CoordinatorConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add/Edit dialog state.
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editSecret, setEditSecret] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete dialog state.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CoordinatorConfigEntry | null>(
    null
  );
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    async function fetchConfig() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch('/api/config');
        if (!res.ok) {
          setError(await extractApiError(res));
          return;
        }
        setEntries(await res.json());
      } catch (err) {
        setError(networkErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    fetchConfig();
  }, [authFetch]);

  const openAdd = () => {
    setEditKey(null);
    setEditSecret(false);
    setEditDescription('');
    setEditValue('');
    setEditOpen(true);
  };

  const openEdit = (entry: CoordinatorConfigEntry) => {
    setEditKey(entry.key);
    setEditSecret(entry.secret);
    setEditDescription(entry.description ?? '');
    // Secrets are write-only: leave empty to keep the current value.
    setEditValue(entry.secret ? '' : entry.value);
    setEditOpen(true);
  };

  const handleSave = async () => {
    if (!editKey) return;
    setSaving(true);
    try {
      const value = editValue.trim();
      const editingSecret = editSecret;
      // Secrets are write-only: an empty value on edit means "keep the
      // current stored secret" — omit value from the PUT so the coordinator
      // preserves it. For a non-secret (or a fresh secret with a value), the
      // value is always sent.
      const body: Record<string, unknown> = {
        secret: editingSecret,
        description: editDescription,
      };
      if (!(editingSecret && value === '')) {
        body.value = value;
      }

      const res = await authFetch(`/api/config/${encodeURIComponent(editKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }

      const saved = (await res.json()) as CoordinatorConfigEntry;
      const next = entries.filter(e => e.key !== saved.key);
      setEntries([...next, saved].sort((a, b) => a.key.localeCompare(b.key)));
      setEditOpen(false);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(
        `/api/config/${encodeURIComponent(deleteTarget.key)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setEntries(prev => prev.filter(e => e.key !== deleteTarget.key));
      setDeleteOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Config</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Global agent configuration distributed to the swarm
          </p>
        </div>
        <Button onClick={openAdd}>Add Config</Button>
      </div>

      {/* Persistent trust warning — secrets are only distributed to APPROVED
          beacons, so the user must verify each beacon before approving. */}
      <div
        className="mb-4 p-3 rounded-md bg-amber-500/10 text-amber-700 text-sm dark:text-amber-400"
        role="note"
      >
        Configuration (including LLM provider API keys) is distributed to
        APPROVED beacons only. Verify each beacon before approving. Secrets are
        stored on this coordinator and never shown in full after saving.
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No config entries</p>
          <p className="text-sm mt-1">
            Add provider entries, llm.active, compaction, or session.guardrail
            settings to distribute to approved beacons.
          </p>
          <p className="text-xs mt-2 font-mono">
            Allowed keys: {ALLOWLIST_PATTERNS.join(', ')}
          </p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 px-3">Key</th>
              <th className="py-2 px-3">Value</th>
              <th className="py-2 px-3">Secret</th>
              <th className="py-2 px-3">Updated</th>
              <th className="py-2 px-3" />
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.key} className="border-b">
                <td className="py-2 px-3 align-top font-mono text-xs">
                  {entry.key}
                </td>
                <td className="py-2 px-3 align-top font-mono text-xs break-all">
                  {previewValue(entry)}
                </td>
                <td className="py-2 px-3 align-top">
                  {entry.secret ? (
                    <Badge variant="secondary" className="text-xs">
                      secret
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      plain
                    </Badge>
                  )}
                </td>
                <td className="py-2 px-3 align-top text-xs">
                  {formatUpdated(entry.updatedAt)}
                </td>
                <td className="py-2 px-3 align-top whitespace-nowrap">
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(entry)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setDeleteTarget(entry);
                        setDeleteOpen(true);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add / Edit dialog */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onConfirm={handleSave}
        title={editKey ? `Edit ${editKey}` : 'Add Config'}
        description={
          editKey
            ? undefined
            : `Key must match an allowed pattern: ${ALLOWLIST_PATTERNS.join(', ')}`
        }
        confirmLabel="Save"
        loading={saving}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Key</label>
            <Input
              value={editKey ?? ''}
              onChange={e => setEditKey(e.target.value)}
              disabled={editKey !== null}
              placeholder="providers.openai"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Value (JSON string for provider entries)
            </label>
            <textarea
              className="w-full h-24 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              placeholder={editSecret ? 'Leave empty to keep current' : '{}'}
            />
            {editSecret && (
              <p className="text-xs text-muted-foreground mt-1">
                Secrets are write-only: leave the value empty to keep the
                current stored secret unchanged.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Secret</label>
            <input
              type="checkbox"
              className="mt-1"
              checked={editSecret}
              onChange={e => setEditSecret(e.target.checked)}
              disabled={editKey !== null && editSecret}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
            />
          </div>
        </div>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleDelete}
        title="Delete Config Entry"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.key}"? This will stop distributing it to approved beacons on the next sync. This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteLoading}
      />
    </div>
  );
}