import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import { useToast } from '@/hooks/use-toast';
import { ErrorBanner } from '@/components/error-banner';
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
// How long a just-archived session lingers as an in-place pending row with an
// undo button before a refetch removes it from the list.
const ARCHIVE_UNDO_MS = 5000;

type SessionRow = BeaconSession & { status?: string };

interface PendingArchive {
  row: SessionRow;
  timer: ReturnType<typeof setTimeout>;
}

export default function SessionsPage() {
  const navigate = useNavigate();
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const { error: showError } = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  // Sessions awaiting the archive undo window: ids for rendering, plus a ref
  // holding each pending row and its expiry timer. The ref survives refetches
  // so a pending row can be merged back into a freshly fetched page, and the
  // timer callbacks read offsetRef instead of a captured offset to stay fresh.
  const [archivedPendingIds, setArchivedPendingIds] = useState<Set<string>>(
    () => new Set()
  );
  const pendingRef = useRef<Map<string, PendingArchive>>(new Map());
  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  useEffect(
    () => () => {
      for (const pending of pendingRef.current.values()) {
        clearTimeout(pending.timer);
      }
    },
    []
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

        // Re-add any pending-archive rows the server omitted (they are
        // archived server-side, so `exclude=archived` drops them while their
        // undo window is open), newest first, capped to one page like the
        // server's createdAt DESC ordering.
        const merged = [...pendingRef.current.values()]
          .map(p => p.row)
          .filter(row => !rows.some(r => r.id === row.id))
          .concat(rows)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, PAGE_SIZE);

        setSessions(merged);
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

  const clearPending = useCallback((id: string) => {
    const pending = pendingRef.current.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRef.current.delete(id);
    }
    setArchivedPendingIds(prev => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const expirePending = useCallback(
    (id: string) => {
      clearPending(id);
      fetchSessions(offsetRef.current);
    },
    [clearPending, fetchSessions]
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
    const res = await authFetch(`/api/sessions/${session.id}/end`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to end session');
      return;
    }
    refresh();
  };

  const handleProcess = async (session: SessionRow) => {
    const res = await authFetch(`/api/sessions/${session.id}/process`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to process session');
      return;
    }
    refresh();
  };

  const handleMarkProcessed = async (session: SessionRow) => {
    const res = await authFetch(`/api/sessions/${session.id}/processed`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to mark session processed');
      return;
    }
    refresh();
  };

  const handleEnd = async (session: SessionRow) => {
    const res = await authFetch(`/api/sessions/${session.id}/end`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to end session');
      return;
    }
    refresh();
  };

  const handleRestore = async (session: SessionRow) => {
    const res = await authFetch(`/api/sessions/${session.id}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to restore session');
      return;
    }
    refresh();
  };

  const handleArchive = async (session: SessionRow) => {
    const res = await authFetch(`/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to archive session');
      return;
    }
    // Flag the row in place with an undo window; the expiry refetch pulls the
    // next page row into the freed slot.
    const timer = setTimeout(() => {
      expirePending(session.id);
    }, ARCHIVE_UNDO_MS);
    pendingRef.current.set(session.id, { row: session, timer });
    setArchivedPendingIds(prev => new Set(prev).add(session.id));
  };

  const handleUndoArchive = async (id: string) => {
    const pending = pendingRef.current.get(id);
    if (!pending) {
      return;
    }
    clearPending(id);
    const res = await authFetch(`/api/sessions/${id}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      showError('Failed to restore session');
    }
    // Either way, refetch so the server's view resolves the row's slot.
    fetchSessions(offsetRef.current);
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

      <ErrorBanner message={error} />

      {loading && sessions.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
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
                {sessions.map(session => {
                  const pending = archivedPendingIds.has(session.id);
                  return (
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
                      <TableCell>
                        {getStatusBadge(pending ? 'archived' : session.status)}
                      </TableCell>
                      <TableCell>
                        {formatDuration(session.connectedAt)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(session.connectedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {pending ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleUndoArchive(session.id)}
                            >
                              Undo
                            </Button>
                          ) : (
                            <>
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
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
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
