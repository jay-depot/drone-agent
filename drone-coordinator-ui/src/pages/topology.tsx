import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Beacon, AgentLocation, WsInitialMessage } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function TopologyPage() {
  const navigate = useNavigate();
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [beacons, setBeacons] = useState<Beacon[]>([]);
  const [agentLocations, setAgentLocations] = useState<AgentLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAction, setDialogAction] = useState<
    'approve' | 'reject' | 'remove' | null
  >(null);
  const [dialogBeacon, setDialogBeacon] = useState<Beacon | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);

  useEffect(() => {
    const unsubInitial = subscribe('initial', msg => {
      const data = (msg as WsInitialMessage).data;
      setBeacons(data.beacons);
      setAgentLocations(data.agentLocations);
    });

    return () => {
      unsubInitial();
    };
  }, [subscribe]);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const [beaconsRes, agentsRes] = await Promise.all([
          authFetch('/api/beacons'),
          authFetch('/api/agents/location'),
        ]);
        if (beaconsRes.ok) {
          setBeacons(await beaconsRes.json());
        }
        if (agentsRes.ok) {
          setAgentLocations(await agentsRes.json());
        }
      } catch {
        setError('Failed to load topology data');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [authFetch]);

  const getAgentCountForBeacon = (beaconId: string): number => {
    return agentLocations.filter(a => a.beaconId === beaconId).length;
  };

  const isBeaconOnline = (beacon: Beacon): boolean => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    return now - beacon.lastHeartbeat < fiveMinutes;
  };

  const openDialog = (
    action: 'approve' | 'reject' | 'remove',
    beacon: Beacon
  ) => {
    setDialogAction(action);
    setDialogBeacon(beacon);
    setDialogOpen(true);
  };

  const handleDialogConfirm = async () => {
    if (!dialogBeacon || !dialogAction) return;

    setDialogLoading(true);
    try {
      if (dialogAction === 'approve') {
        const res = await authFetch(
          `/api/beacons/trust/${dialogBeacon.id}/approve`,
          {
            method: 'POST',
          }
        );
        if (res.ok) {
          // Refresh beacon list
          const beaconsRes = await authFetch('/api/beacons');
          if (beaconsRes.ok) {
            setBeacons(await beaconsRes.json());
          }
        }
      } else if (dialogAction === 'reject') {
        const res = await authFetch(
          `/api/beacons/trust/${dialogBeacon.id}/reject`,
          { method: 'POST' }
        );
        if (res.ok) {
          const beaconsRes = await authFetch('/api/beacons');
          if (beaconsRes.ok) {
            setBeacons(await beaconsRes.json());
          }
        }
      } else if (dialogAction === 'remove') {
        const res = await authFetch(`/api/beacons/trust/${dialogBeacon.id}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          const beaconsRes = await authFetch('/api/beacons');
          if (beaconsRes.ok) {
            setBeacons(await beaconsRes.json());
          }
        }
      }
      setDialogOpen(false);
    } catch {
      // Error handled silently
    } finally {
      setDialogLoading(false);
    }
  };

  const getDialogContent = () => {
    if (!dialogBeacon || !dialogAction) return { title: '', description: '' };

    switch (dialogAction) {
      case 'approve':
        return {
          title: `Approve Beacon: ${dialogBeacon.name}`,
          description: `Approve beacon "${dialogBeacon.name}" (${dialogBeacon.id})? Before approving, verify the bidirectional verification code matches the one shown on the beacon to rule out a MitM attack.`,
        };
      case 'reject':
        return {
          title: `Reject Beacon: ${dialogBeacon.name}`,
          description:
            'Are you sure you want to reject this beacon? The beacon will not be able to connect.',
        };
      case 'remove':
        return {
          title: `Remove Beacon: ${dialogBeacon.name}`,
          description:
            'Are you sure you want to remove this beacon? This will revoke its trust and disconnect it.',
        };
    }
  };

  if (loading) {
    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Swarm Topology</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Beacon overview and agent distribution
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Swarm Topology</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Beacon overview and agent distribution
          </p>
        </div>
        <Badge
          variant={status === 'connected' ? 'default' : 'secondary'}
          className="text-xs"
        >
          {status === 'connected'
            ? '● Live'
            : status === 'connecting'
              ? '○ Connecting'
              : '○ Disconnected'}
        </Badge>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {beacons.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No beacons registered</p>
          <p className="text-sm mt-1">
            Beacons will appear here once they connect to the coordinator.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {beacons.map(beacon => {
            const online = isBeaconOnline(beacon);
            const agentCount = getAgentCountForBeacon(beacon.id);
            return (
              <Card
                key={beacon.id}
                className={`${!online ? 'opacity-70' : ''} cursor-pointer hover:ring-2 hover:ring-ring/50 transition-all`}
                onClick={() => navigate(`/beacons/${beacon.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{beacon.name}</CardTitle>
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        online ? 'bg-green-500' : 'bg-red-400'
                      }`}
                      title={online ? 'Online' : 'Offline'}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">ID</span>
                      <span className="font-mono text-xs">{beacon.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Address</span>
                      <span>
                        {beacon.host}:{beacon.port}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge
                        variant={
                          beacon.trustStatus === 'approved'
                            ? 'default'
                            : beacon.trustStatus === 'pending'
                              ? 'secondary'
                              : 'outline'
                        }
                        className="text-xs"
                      >
                        {beacon.trustStatus ?? 'unknown'}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Active Agents
                      </span>
                      <span className="font-medium">{agentCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Last Heartbeat
                      </span>
                      <span className="text-xs">
                        {new Date(beacon.lastHeartbeat).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Management actions */}
                  <div
                    className="mt-3 pt-3 border-t flex gap-2"
                    onClick={e => e.stopPropagation()}
                  >
                    {beacon.trustStatus === 'pending' && (
                      <>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => openDialog('approve', beacon)}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => openDialog('reject', beacon)}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {beacon.trustStatus === 'approved' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => openDialog('remove', beacon)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Confirmation Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleDialogConfirm}
        title={getDialogContent().title}
        description={getDialogContent().description}
        confirmLabel={
          dialogAction === 'approve'
            ? 'Approve'
            : dialogAction === 'reject'
              ? 'Reject'
              : 'Remove'
        }
        variant={dialogAction === 'approve' ? 'default' : 'destructive'}
        loading={dialogLoading}
      ></Dialog>
    </div>
  );
}
