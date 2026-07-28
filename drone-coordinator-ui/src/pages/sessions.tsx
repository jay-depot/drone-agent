import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type {
  BeaconSession,
  WsInitialMessage,
  SwarmSession,
} from '@/lib/types';
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
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 20;

type SessionRow = BeaconSession & { status?: string };

export default function SessionsPage() {
  const navigate = useNavigate();
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAction, setDialogAction] = useState<
    'terminate' | 'process' | 'processed' | null
  >(null);
  const [dialogSession, setDialogSession] = useState<SessionRow | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);

  const fetchSessions = useCallback(
    async (currentOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        // Fetch sessions with pagination and status from the coordinator
        const sessionsRes = await authFetch(
          `/sessions?limit=${PAGE_SIZE}&offset=${currentOffset}`
        );
        if (!sessionsRes.ok) {
          setError('Failed to load sessions');
          setLoading(false);
          return;
        }
        const data = await sessionsRes.json();
        const swarmSessions: SwarmSession[] = data.sessions || [];

        // Enrich with beacon names
        const beaconsRes = await authFetch('/beacons');
        const beacons = beaconsRes.ok ? await beaconsRes.json() : [];
        const beaconMap = new Map(
          (beacons as Array<{ id: string; name: string }>).map(b => [
            b.id,
            b.name,
          ])
        );

        const rows: SessionRow[] = swarmSessions.map(s => ({
          id: s.id,
          beaconId: s.beaconId,
          agentId: s.id,
          personaId: s.personaId,
          connectedAt: s.createdAt,
          disconnectedAt: null,
          durationMs: null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          status: s.status,
          beaconName: beaconMap.get(s.beaconId) ?? s.beaconId,
        }));

        setSessions(rows);
        setHasMore(data.count > currentOffset + PAGE_SIZE);
      } catch {
        setError('Failed to load sessions');
      } finally {
        setLoading(false);
      }
    },
    [authFetch]
  );

  // Subscribe to WebSocket for live updates
  useEffect(() => {
    const unsubInitial = subscribe('initial', msg => {
      const data = (msg as WsInitialMessage).data;
      if (data.sessions.length > 0) {
        setSessions(prev => {
          const existingIds = new Set(prev.map(s => s.id));
          const newSessions = data.sessions.filter(s => !existingIds.has(s.id));
          return [...newSessions, ...prev];
        });
      }
    });

    return () => {
      unsubInitial();
    };
  }, [subscribe]);

  // Fetch on mount and when offset changes
  useEffect(() => {
    fetchSessions(offset);
  }, [offset, fetchSessions]);

  const formatDuration = (connectedAt: number): string => {
    const ms = Date.now() - connectedAt;
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  };

  const openDialog = (
    action: 'terminate' | 'process' | 'processed',
    session: SessionRow
  ) => {
    setDialogAction(action);
    setDialogSession(session);
    setDialogOpen(true);
  };

  const handleDialogConfirm = async () => {
    if (!dialogSession || !dialogAction) return;

    setDialogLoading(true);
    try {
      if (dialogAction === 'terminate') {
        // Try to end the beacon session (may already be ended)
        try {
          await authFetch(
            `/beacons/${dialogSession.beaconId}/sessions/${dialogSession.agentId}`,
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                disconnectedAt: Date.now(),
                durationMs: Date.now() - dialogSession.connectedAt,
              }),
            }
          );
        } catch {
          // Beacon session may already be ended — that's fine
        }
        // Always update the swarm session status
        await authFetch(`/sessions/${dialogSession.id}/end`, {
          method: 'POST',
        });
      } else if (dialogAction === 'process') {
        await authFetch(`/sessions/${dialogSession.id}/process`, {
          method: 'POST',
        });
      } else if (dialogAction === 'processed') {
        await authFetch(`/sessions/${dialogSession.id}/processed`, {
          method: 'POST',
        });
      }
      setDialogOpen(false);
      // Refresh
      fetchSessions(offset);
    } catch {
      // Error handled silently
    } finally {
      setDialogLoading(false);
    }
  };

  const getStatusBadge = (sessionStatus?: string) => {
    switch (sessionStatus) {
      case 'active':
        return (
          <Badge variant="default" className="text-xs">
            Active
          </Badge>
        );
      case 'processing':
        return (
          <Badge variant="secondary" className="text-xs">
            Processing
          </Badge>
        );
      case 'processed':
        return (
          <Badge variant="outline" className="text-xs">
            Processed
          </Badge>
        );
      case 'finished':
        return (
          <Badge variant="outline" className="text-xs">
            Finished
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-xs">
            {sessionStatus ?? 'unknown'}
          </Badge>
        );
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Sessions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Swarm sessions across all beacons
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

      {loading && sessions.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No sessions</p>
          <p className="text-sm mt-1">
            Agent sessions will appear here when agents are connected to
            beacons.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Beacon</TableHead>
                  <TableHead>Agent ID</TableHead>
                  <TableHead>Persona</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map(session => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      {session.beaconName ?? session.beaconId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {session.agentId}
                    </TableCell>
                    <TableCell>
                      {session.personaId ? (
                        <Badge variant="outline">{session.personaId}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{getStatusBadge(session.status)}</TableCell>
                    <TableCell>{formatDuration(session.connectedAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(session.connectedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            navigate(`/sessions/${session.agentId}`)
                          }
                        >
                          Peek
                        </Button>
                        {session.status === 'active' && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => openDialog('terminate', session)}
                          >
                            Terminate
                          </Button>
                        )}
                        {(session.status === 'finished' ||
                          session.status === 'stale') && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openDialog('process', session)}
                          >
                            Process
                          </Button>
                        )}
                        {session.status === 'processing' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openDialog('processed', session)}
                          >
                            Mark Processed
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-muted-foreground">
              Showing {sessions.length} session
              {sessions.length !== 1 ? 's' : ''}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasMore}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Confirmation Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleDialogConfirm}
        title={
          dialogAction === 'terminate'
            ? 'Terminate Session'
            : dialogAction === 'process'
              ? 'Process Session'
              : 'Mark Session as Processed'
        }
        description={
          dialogAction === 'terminate'
            ? `Are you sure you want to terminate session ${dialogSession?.agentId?.slice(0, 12)}...?`
            : dialogAction === 'process'
              ? `Mark session ${dialogSession?.agentId?.slice(0, 12)}... as processing?`
              : `Mark session ${dialogSession?.agentId?.slice(0, 12)}... as processed?`
        }
        confirmLabel={
          dialogAction === 'terminate'
            ? 'Terminate'
            : dialogAction === 'process'
              ? 'Process'
              : 'Mark Processed'
        }
        variant={dialogAction === 'terminate' ? 'destructive' : 'default'}
        loading={dialogLoading}
      />
    </div>
  );
}
