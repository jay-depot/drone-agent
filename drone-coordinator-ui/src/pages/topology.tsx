import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Beacon, AgentLocation, WsInitialMessage } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function TopologyPage() {
  const { status, subscribe } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [beacons, setBeacons] = useState<Beacon[]>([]);
  const [agentLocations, setAgentLocations] = useState<AgentLocation[]>([]);

  useEffect(() => {
    // Subscribe to initial state
    const unsubInitial = subscribe('initial', msg => {
      const data = (msg as WsInitialMessage).data;
      setBeacons(data.beacons);
      setAgentLocations(data.agentLocations);
    });

    return () => {
      unsubInitial();
    };
  }, [subscribe]);

  // Fetch initial data via REST as well (in case WS hasn't connected yet)
  useEffect(() => {
    async function fetchData() {
      try {
        const [beaconsRes, agentsRes] = await Promise.all([
          authFetch('/beacons'),
          authFetch('/agents/location'),
        ]);
        if (beaconsRes.ok) {
          const beaconsData = await beaconsRes.json();
          setBeacons(beaconsData);
        }
        if (agentsRes.ok) {
          const agentsData = await agentsRes.json();
          setAgentLocations(agentsData);
        }
      } catch {
        // Will get data via WebSocket eventually
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
              <Card key={beacon.id} className={!online ? 'opacity-70' : ''}>
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
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
