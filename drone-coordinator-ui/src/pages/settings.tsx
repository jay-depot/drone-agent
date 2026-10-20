import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { ErrorBanner } from '@/components/error-banner';
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
import { ExtensionSections } from '@/extensions/ExtensionContext';
import ConfigPage from '@/pages/config';
import { Skeleton } from '@/components/ui/skeleton';

interface CoordinatorSettings {
  fingerprint?: string;
  webPort?: number;
}

/**
 * The Settings page. Sections, in order:
 *   1. Coordinator Settings   — read-only coordinator identity/status
 *   2. Shared Agent Config     — the config entries distributed to beacons
 *   3. One section per extension (core-provided heading, from the
 *      `settings-panel` region)
 */
export default function SettingsPage() {
  const authFetch = useAuthenticatedFetch();
  const [health, setHealth] = useState<CoordinatorSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchHealth() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch('/health');
        if (!res.ok) {
          setError(await extractApiError(res));
          return;
        }
        setHealth((await res.json()) as CoordinatorSettings);
      } catch (err) {
        setError(networkErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    fetchHealth();
  }, [authFetch]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Coordinator configuration, shared agent config, and extension settings
        </p>
      </div>

      <ErrorBanner message={error} />

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">Coordinator Settings</h2>
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="rounded-md border p-4 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span>ok</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">TLS fingerprint</span>
              <span className="font-mono text-xs">
                {health?.fingerprint ?? '(HTTPS disabled)'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Web UI port</span>
              <span>{health?.webPort ?? '—'}</span>
            </div>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">Shared Agent Config</h2>
        <ConfigPage embedded />
      </section>

      <ExtensionSections />
    </div>
  );
}
