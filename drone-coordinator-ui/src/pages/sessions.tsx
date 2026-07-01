import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { BeaconSession, WsInitialMessage } from '@/lib/types';
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

export default function SessionsPage() {
  const navigate = useNavigate();
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [sessions, setSessions] = useState<BeaconSession[]>([]);

  useEffect(() => {
    const unsubInitial = subscribe('initial', msg => {
      const data = (msg as WsInitialMessage).data;
      setSessions(data.sessions);
    });

    return () => {
      unsubInitial();
    };
  }, [subscribe]);

  // Fetch via REST as fallback
  useEffect(() => {
    async function fetchSessions() {
      try {
        const beaconsRes = await authFetch('/beacons');
        if (!beaconsRes.ok) return;
        const beacons = await beaconsRes.json();

        const allSessions: BeaconSession[] = [];
        for (const beacon of beacons) {
          const sessionsRes = await authFetch(`/beacons/${beacon.id}/sessions`);
          if (sessionsRes.ok) {
            const beaconSessions = await sessionsRes.json();
            allSessions.push(
              ...beaconSessions.map((s: BeaconSession) => ({
                ...s,
                beaconName: beacon.name,
                beaconHost: beacon.host,
                beaconPort: beacon.port,
              }))
            );
          }
        }
        setSessions(allSessions);
      } catch {
        // Will get data via WebSocket
      }
    }
    fetchSessions();
  }, [authFetch]);

  const formatDuration = (connectedAt: number): string => {
    const ms = Date.now() - connectedAt;
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Sessions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Active swarm sessions across all beacons
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

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No active sessions</p>
          <p className="text-sm mt-1">
            Agent sessions will appear here when agents are connected to
            beacons.
          </p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Beacon</TableHead>
                <TableHead>Agent ID</TableHead>
                <TableHead>Persona</TableHead>
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
                  <TableCell>{formatDuration(session.connectedAt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(session.connectedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/sessions/${session.agentId}`)}
                    >
                      Peek
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
