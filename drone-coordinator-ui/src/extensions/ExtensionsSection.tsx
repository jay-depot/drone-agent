import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ExtensionManifestEntry } from './types';

/**
 * The Topology page's **Extensions** section: the same node registry, filtered
 * to nodes that declared a capability manifest. Reads `GET /api/extensions`.
 */
export function ExtensionsSection() {
  const authFetch = useAuthenticatedFetch();
  const [entries, setEntries] = useState<ExtensionManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchExtensions() {
      try {
        const res = await authFetch('/api/extensions');
        if (res.ok && !cancelled) {
          setEntries((await res.json()) as ExtensionManifestEntry[]);
        }
      } catch {
        // Non-fatal: the section simply shows empty.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchExtensions();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  if (loading) {
    return <Skeleton className="h-20 w-full" />;
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p className="text-lg">No extensions registered</p>
        <p className="text-sm mt-1">
          A node appears here once it declares a capability manifest.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {entries.map(entry => (
        <Card key={entry.nodeId}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{entry.nodeId}</CardTitle>
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  entry.connected ? 'bg-green-500' : 'bg-red-400'
                }`}
                title={entry.connected ? 'Connected' : 'Disconnected'}
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Capabilities</span>
                <Badge variant="secondary" className="text-xs">
                  {entry.capabilities.length}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bundles</span>
                <Badge variant="outline" className="text-xs">
                  {entry.bundles.length}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Protocol</span>
                <span className="font-mono text-xs">
                  v{entry.protocolVersion}
                </span>
              </div>
            </div>
            {entry.capabilities.length > 0 && (
              <ul className="mt-2 pt-2 border-t text-xs text-muted-foreground space-y-0.5">
                {entry.capabilities.map(cap => (
                  <li key={cap.name} className="font-mono">
                    {cap.name}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
