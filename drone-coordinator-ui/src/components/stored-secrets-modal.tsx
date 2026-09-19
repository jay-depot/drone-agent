import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import type { StoredSecretEntry } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';

function formatUpdated(updatedAt: number): string {
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return '';
  }
}

export default function StoredSecretsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [secrets, setSecrets] = useState<StoredSecretEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Add / Rotate form state.
  const [formOpen, setFormOpen] = useState(false);
  const [targetName, setTargetName] = useState('');
  const [isNew, setIsNew] = useState(true);
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  // Delete confirm state.
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function loadSecrets() {
    setLoading(true);
    try {
      const res = await authFetch('/api/secrets');
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setSecrets((await res.json()) as StoredSecretEntry[]);
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      loadSecrets();
    }
  }, [open]);

  const openAdd = () => {
    setTargetName('');
    setIsNew(true);
    setValue('');
    setShowValue(false);
    setFormOpen(true);
  };

  const openRotate = (name: string) => {
    setTargetName(name);
    setIsNew(false);
    setValue('');
    setShowValue(false);
    setFormOpen(true);
  };

  const handleSave = async () => {
    if (!targetName.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      // Rotate with an empty value keeps the current secret (write-only).
      if (value.trim() !== '') {
        body.value = value.trim();
      }
      const res = await authFetch(
        `/api/secrets/${encodeURIComponent(targetName.trim())}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setFormOpen(false);
      await loadSecrets();
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteName) return;
    setDeleting(true);
    try {
      const res = await authFetch(
        `/api/secrets/${encodeURIComponent(deleteName)}`,
        {
          method: 'DELETE',
        }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setDeleteName(null);
      await loadSecrets();
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const deletingTarget = secrets.find(s => s.name === deleteName);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onConfirm={onClose}
      title="Stored Secrets"
      description="Secrets referenced from settings via ${secret:NAME}. Values are stored on this coordinator and never shown in full."
      confirmLabel="Close"
    >
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button size="sm" onClick={openAdd}>
            Add Secret
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No stored secrets yet. Add one to reference it from a config
            setting.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Value</th>
                <th className="py-2 px-2">Referenced by</th>
                <th className="py-2 px-2">Updated</th>
                <th className="py-2 px-2" />
              </tr>
            </thead>
            <tbody>
              {secrets.map(secret => (
                <tr key={secret.name} className="border-b">
                  <td className="py-2 px-2 font-mono text-xs">{secret.name}</td>
                  <td className="py-2 px-2 font-mono text-xs">
                    {secret.maskedValue}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {secret.referencedBy.length > 0 ? (
                      <Badge variant="outline" className="text-xs">
                        {secret.referencedBy.length}{' '}
                        {secret.referencedBy.length === 1
                          ? 'setting'
                          : 'settings'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {formatUpdated(secret.updatedAt)}
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap">
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openRotate(secret.name)}
                      >
                        Rotate
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteName(secret.name)}
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
      </div>

      {/* Add / Rotate form */}
      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onConfirm={handleSave}
        title={isNew ? 'Add Secret' : `Rotate ${targetName}`}
        description={
          isNew
            ? 'Name may contain only letters, digits, and underscores.'
            : 'Leave the value empty to keep the current secret unchanged.'
        }
        confirmLabel="Save"
        loading={saving}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={targetName}
              onChange={e => setTargetName(e.target.value)}
              disabled={!isNew}
              placeholder="OPENROUTER_API_KEY"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Value</label>
            <div className="flex gap-2">
              <Input
                type={showValue ? 'text' : 'password'}
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={isNew ? 'sk-…' : 'Leave empty to keep current'}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowValue(v => !v)}
              >
                {showValue ? 'Hide' : 'Show'}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      {/* Delete confirmation (lists referencing settings) */}
      <Dialog
        open={deleteName !== null}
        onClose={() => setDeleteName(null)}
        onConfirm={handleDelete}
        title="Delete Stored Secret"
        description={
          deletingTarget
            ? `Delete "${deletingTarget.name}"?${
                deletingTarget.referencedBy.length > 0
                  ? ` It is referenced by: ${deletingTarget.referencedBy.join(', ')}. Those settings will stop being distributed until the references are fixed.`
                  : ' This cannot be undone.'
              }`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleting}
      />
    </Dialog>
  );
}
