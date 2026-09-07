import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
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
import { Skeleton } from '@/components/ui/skeleton';
import { paginationRange } from '@/lib/pagination';

const PAGE_SIZE = 20;
// How long a just-archived session lingers as a phantom row with an undo
// button before disappearing from view.
const ARCHIVE_UNDO_MS = 5000;

type SessionRow = BeaconSession & { status?: string };

type PhantomArchive = {
  session: SessionRow;
  timer: ReturnType<typeof setTimeout>;
};

export default function SessionsPage() {
  const navigate = useNavigate();
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  // Phantom row for a just-archived session, offering a brief undo window.
  const [phantomArchive, setPhantomArchive] = useState<PhantomArchive | null>(
    null
  );

  // Archived view state, persisted in the URL (mirrors pagination offset).
  const [searchParams, setSearchParams] = useSearchParams();
  const archivedView = searchParams.get('view') === 'archived';
  const setArchivedView = useCallback(
    (next: boolean) => {
      const params = new URLSearchParams(searchParams);
      if (next) {
        params.set('view', 'archived');
      } else {
        params.delete('view');
      }
      // Reset pagination to the first page when switching views.
      setOffset(0);
      setSearchParams(params);
    },
    [searchParams, setOffset, setSearchParams]
  );

  const cancelPhantomTimer = useCallback((phantom: PhantomArchive | null) => {
    if (phantom) {
      clearTimeout(phantom.timer);
    }
  }, []);

  const fetchSessions = useCallback(
    async (currentOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        // Normal view hides archived sessions; archived view lists only them.
        const filter = archivedView ? `status=archived` : `exclude=archived`;
        const sessionsRes = await authFetch(
          `/api/sessions?limit=${PAGE_SIZE}&offset=${currentOffset}&${filter}`
        );
        if (!sessionsRes.ok) {
          setError('Failed to load sessions');
          setLoading(false);
          return;
        }
        const data = await sessionsRes.json();
        const swarmSessions: SwarmSession[] = data.sessions || [];
        setTotal(data.count ?? 0);

        // Enrich with beacon names
        const beaconsRes = await authFetch('/api/beacons');
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
    [authFetch, archivedView]
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

  const refresh = useCallback(
    () => fetchSessions(offset),
    [fetchSessions, offset]
  );

  const handleTerminate = async (session: SessionRow) => {
    // Try to end the beacon session (may already be ended)
    try {
      await authFetch(
        `/api/beacons/${session.beaconId}/sessions/${session.agentId}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            disconnectedAt: Date.now(),
            durationMs: Date.now() - session.connectedAt,
          }),
        }
      );
    } catch {
      // Beacon session may already be ended — that's fine
    }
    // Always update the swarm session status
    await authFetch(`/api/sessions/${session.id}/end`, {
      method: 'POST',
    });
    refresh();
  };

  const handleProcess = async (session: SessionRow) => {
    await authFetch(`/api/sessions/${session.id}/process`, {
      method: 'POST',
    });
    refresh();
  };

  const handleMarkProcessed = async (session: SessionRow) => {
    await authFetch(`/api/sessions/${session.id}/processed`, {
      method: 'POST',
    });
    refresh();
  };

  const handleEnd = async (session: SessionRow) => {
    await authFetch(`/api/sessions/${session.id}/end`, {
      method: 'POST',
    });
    refresh();
  };

  const handleRestore = async (session: SessionRow) => {
    await authFetch(`/api/sessions/${session.id}/restore`, {
      method: 'POST',
    });
    refresh();
  };

  const handleArchive = async (session: SessionRow) => {
    cancelPhantomTimer(phantomArchive);
    await authFetch(`/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    // Remove the archived session immediately and drop in a phantom row with a
    // brief undo window.
    setSessions(prev => prev.filter(s => s.id !== session.id));
    const timer = setTimeout(() => {
      setPhantomArchive(null);
    }, ARCHIVE_UNDO_MS);
    setPhantomArchive({ session, timer });
  };

  const handleUndoArchive = async () => {
    if (!phantomArchive) return;
    cancelPhantomTimer(phantomArchive);
    setPhantomArchive(null);
    await authFetch(`/api/sessions/${phantomArchive.session.id}/restore`, {
      method: 'POST',
    });
    refresh();
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
      case 'ended':
        return (
          <Badge variant="outline" className="text-xs">
            Ended
          </Badge>
        );
      case 'stale':
        return (
          <Badge variant="outline" className="text-xs">
            Stale
          </Badge>
        );
      case 'archived':
        return (
          <Badge variant="ghost" className="text-xs">
            Archived
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

  const viewLabel = archivedView ? 'Sessions' : 'Archived';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Sessions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Swarm sessions across all beacons
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant={archivedView ? 'default' : 'outline'}
            size="sm"
            onClick={() => setArchivedView(!archivedView)}
            title={
              archivedView ? 'Show sessions' : 'Show only archived sessions'
            }
          >
            {viewLabel}
          </Button>
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
      ) : sessions.length === 0 && !phantomArchive ? (
        <div className="text-center py-12 text-muted-foreground">
          {archivedView ? (
            <>
              <p className="text-lg">No archived sessions</p>
              <p className="text-sm mt-1">
                Archive a processed session to move it here.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg">No sessions</p>
              <p className="text-sm mt-1">
                Agent sessions will appear here when agents are connected to
                beacons.
              </p>
            </>
          )}
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
                {phantomArchive && (
                  <TableRow key="phantom-archive">
                    <TableCell className="font-medium">
                      {phantomArchive.session.beaconName ??
                        phantomArchive.session.beaconId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {phantomArchive.session.agentId}
                    </TableCell>
                    <TableCell>
                      {phantomArchive.session.personaId ? (
                        <Badge variant="outline">
                          {phantomArchive.session.personaId}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{getStatusBadge('archived')}</TableCell>
                    <TableCell>
                      {formatDuration(phantomArchive.session.connectedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(
                        phantomArchive.session.connectedAt
                      ).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleUndoArchive()}
                      >
                        Undo
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
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
                            onClick={() => handleTerminate(session)}
                          >
                            Terminate
                          </Button>
                        )}
                        {(session.status === 'stale' ||
                          session.status === 'ended') && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleProcess(session)}
                          >
                            Process
                          </Button>
                        )}
                        {session.status === 'processing' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleMarkProcessed(session)}
                          >
                            Mark Processed
                          </Button>
                        )}
                        {(session.status === 'stale' ||
                          session.status === 'processing' ||
                          session.status === 'processed') && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEnd(session)}
                          >
                            End
                          </Button>
                        )}
                        {session.status === 'processed' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleArchive(session)}
                          >
                            Archive
                          </Button>
                        )}
                        {session.status === 'archived' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRestore(session)}
                          >
                            Restore
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
                disabled={!hasMore}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
