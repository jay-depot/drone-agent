import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { BeaconDetail, BeaconSession, AgentLocation } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function BeaconDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const [beacon, setBeacon] = useState<BeaconDetail | null>(null);
  const [sessions, setSessions] = useState<BeaconSession[]>([]);
  const [agents, setAgents] = useState<AgentLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const [beaconRes, sessionsRes, agentsRes] = await Promise.all([
          authFetch(`/beacons/${id}`),
          authFetch(`/beacons/${id}/sessions`),
          authFetch(`/agents/location?beaconId=${id}`),
        ]);

        if (beaconRes.ok) {
          setBeacon(await beaconRes.json());
        } else {
          setError('Beacon not found');
          setLoading(false);
          return;
        }

        if (sessionsRes.ok) {
          setSessions(await sessionsRes.json());
        }

        if (agentsRes.ok) {
          setAgents(await agentsRes.json());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load beacon');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id, authFetch]);

  const isOnline = beacon
    ? Date.now() - beacon.lastHeartbeat < 5 * 60 * 1000
    : false;

  if (!id) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No beacon ID provided.
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/')}>
            ← Back
          </Button>
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (error || !beacon) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/')}>
            ← Back
          </Button>
        </div>
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">{error || 'Beacon not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/')}>
          ← Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{beacon.name}</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono">
            {beacon.id}
          </p>
        </div>
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            isOnline ? 'bg-green-500' : 'bg-red-400'
          }`}
          title={isOnline ? 'Online' : 'Offline'}
        />
      </div>

      {/* Beacon Info */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Beacon Information</CardTitle>
          {beacon.verificationCode && (
            <p className="text-xs text-muted-foreground mt-1">
              Compare this code with the one shown on the beacon to verify no
              MitM attack occurred during key exchange.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Address</span>
              <p className="font-mono mt-0.5">
                {beacon.host}:{beacon.port}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Trust Status</span>
              <p className="mt-0.5">
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
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Connected</span>
              <p className="mt-0.5">
                {new Date(beacon.connectedAt).toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Last Heartbeat</span>
              <p className="mt-0.5">
                {new Date(beacon.lastHeartbeat).toLocaleString()}
              </p>
            </div>
            {beacon.verificationCode && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Verification Code</span>
                <p className="font-mono text-base mt-0.5 font-bold text-primary">
                  {beacon.verificationCode}
                </p>
              </div>
            )}
            {beacon.tlsFingerprint && (
              <div className="col-span-2">
                <span className="text-muted-foreground">TLS Fingerprint</span>
                <p className="font-mono text-xs mt-0.5 break-all">
                  {beacon.tlsFingerprint}
                </p>
              </div>
            )}
            {beacon.publicKey && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Public Key</span>
                <p className="font-mono text-xs mt-0.5 break-all">
                  {beacon.publicKey}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Active Agents */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">
            Active Agents ({agents.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active agents</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent ID</TableHead>
                    <TableHead>Persona</TableHead>
                    <TableHead>Connected</TableHead>
                    <TableHead>Last Heartbeat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map(agent => (
                    <TableRow key={agent.agentId}>
                      <TableCell className="font-mono text-xs">
                        {agent.agentId}
                      </TableCell>
                      <TableCell>
                        {agent.personaId ? (
                          <Badge variant="outline">{agent.personaId}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {new Date(agent.connectedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {new Date(agent.lastHeartbeat).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Sessions ({sessions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent ID</TableHead>
                    <TableHead>Persona</TableHead>
                    <TableHead>Connected</TableHead>
                    <TableHead>Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map(session => (
                    <TableRow key={session.id}>
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
                      <TableCell className="text-xs">
                        {new Date(session.connectedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {session.durationMs
                          ? `${Math.floor(session.durationMs / 60000)}m`
                          : 'Active'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
