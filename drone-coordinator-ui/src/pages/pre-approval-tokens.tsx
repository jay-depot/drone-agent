import { useCallback, useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import { ErrorBanner } from '@/components/error-banner';
import type { PreApprovalToken, PreApprovalTokenEntry } from '@/lib/types';
import { copyText, downloadJson } from '@/lib/download';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SENSITIVE_WARNING =
  'This token is a sensitive credential. Store it securely. It is shown one time only.';

function tokenStatus(
  entry: PreApprovalTokenEntry
): 'unused' | 'burned' | 'expired' {
  if (entry.burnedAt !== null) return 'burned';
  if (entry.expiresAt < Date.now()) return 'expired';
  return 'unused';
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function PreApprovalTokensPage() {
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [entries, setEntries] = useState<PreApprovalTokenEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [issuedToken, setIssuedToken] = useState<PreApprovalToken | null>(null);
  const [revokeTarget, setRevokeTarget] =
    useState<PreApprovalTokenEntry | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/pre-approval-tokens');
      if (!res.ok) {
        setError(await extractApiError(res));
        return;
      }
      setEntries((await res.json()) as PreApprovalTokenEntry[]);
    } catch (err) {
      setError(networkErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await authFetch('/api/pre-approval-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      const body = (await res.json()) as {
        token: PreApprovalToken;
        entry: PreApprovalTokenEntry;
      };
      setIssuedToken(body.token);
      setLabel('');
      await loadEntries();
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await authFetch(
        `/api/pre-approval-tokens/${revokeTarget.durableId}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        showError(await extractApiError(res));
        return;
      }
      setRevokeTarget(null);
      await loadEntries();
    } catch (err) {
      showError(networkErrorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

  const handleCopy = async () => {
    if (!issuedToken) return;
    try {
      await copyText(JSON.stringify(issuedToken, null, 2));
    } catch (err) {
      showError(networkErrorMessage(err));
    }
  };

  const handleDownload = () => {
    if (!issuedToken) return;
    downloadJson(`pre-approval-${issuedToken.durableId}.json`, issuedToken);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Pre-approval tokens</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Mint a one-time token to pre-approve a remote node.
          </p>
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 mb-4">
        {SENSITIVE_WARNING}
      </div>

      <div className="flex items-end gap-3 mb-6">
        <div className="flex-1 max-w-sm">
          <label className="block text-sm font-medium mb-1" htmlFor="label">
            Label (optional)
          </label>
          <Input
            id="label"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="gateway on the pi"
          />
        </div>
        <Button onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating...' : 'Create token'}
        </Button>
      </div>

      {issuedToken && (
        <div className="mb-6 rounded-lg border-2 border-primary/40 bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">New token (shown once)</h2>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                Download
              </Button>
            </div>
          </div>
          <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(issuedToken, null, 2)}
          </pre>
          <button
            type="button"
            className="mt-2 text-xs text-muted-foreground underline"
            onClick={() => setIssuedToken(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tokens yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Durable ID</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map(entry => {
              const status = tokenStatus(entry);
              return (
                <TableRow key={entry.durableId}>
                  <TableCell>{entry.label ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.durableId}
                  </TableCell>
                  <TableCell>{formatTime(entry.issuedAt)}</TableCell>
                  <TableCell>{formatTime(entry.expiresAt)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        status === 'unused'
                          ? 'default'
                          : status === 'burned'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setRevokeTarget(entry)}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke token"
        description={`Revoke the token "${revokeTarget?.label ?? revokeTarget?.durableId}"? A later redemption will fail.`}
        confirmLabel="Revoke"
        variant="destructive"
        loading={revoking}
      />
    </div>
  );
}
