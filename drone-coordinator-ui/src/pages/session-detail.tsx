import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { SwarmEvent, WsEventMessage } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { subscribe, send } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // Fetch events via REST
  useEffect(() => {
    if (!sessionId) return;

    async function fetchEvents() {
      try {
        const res = await authFetch(`/sessions/${sessionId}/events`);
        if (res.ok) {
          const data = await res.json();
          setEvents(data);
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }
    }
    fetchEvents();
  }, [sessionId, authFetch]);

  // Subscribe to new events via WebSocket
  useEffect(() => {
    if (!sessionId) return;

    const unsub = subscribe('event', msg => {
      const eventMsg = msg as WsEventMessage;
      if (eventMsg.sessionId === sessionId) {
        setEvents(prev => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sessionId: eventMsg.sessionId,
            correlationId: null,
            type: eventMsg.eventType,
            payload:
              typeof eventMsg.payload === 'string'
                ? eventMsg.payload
                : JSON.stringify(eventMsg.payload),
            metadata: null,
            createdAt: Date.now(),
          },
        ]);
      }
    });

    // Subscribe to this session using the shared WebSocket
    send({ type: 'subscribe', sessionId });

    return () => {
      unsub();
      send({ type: 'unsubscribe', sessionId });
    };
  }, [sessionId, subscribe, send]);

  // Auto-scroll to latest events
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const tryFormatJson = (
    text: string | null
  ): { formatted: string; isJson: boolean } => {
    if (!text) return { formatted: '', isJson: false };
    try {
      const parsed = JSON.parse(text);
      return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
    } catch {
      return { formatted: text, isJson: false };
    }
  };

  if (!sessionId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No session ID provided.
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/sessions')}
        >
          ← Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Session Detail</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono">
            {sessionId}
          </p>
        </div>
        <Badge variant="default" className="text-xs ml-auto">
          ● Live
        </Badge>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Session Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Session ID</span>
              <p className="font-mono text-xs mt-0.5">{sessionId}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Events</span>
              <p className="font-medium mt-0.5">{events.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading events...
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No events yet</p>
          <p className="text-sm mt-1">
            Events will appear here in real time as the session progresses.
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {events.map(event => {
            const { formatted, isJson } = tryFormatJson(event.payload);
            return (
              <Collapsible key={event.id}>
                <Card className="border-l-4 border-l-primary/30">
                  <CardHeader className="py-2 px-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CollapsibleTrigger className="h-5 px-1 text-xs cursor-pointer">
                          ▶
                        </CollapsibleTrigger>
                        <Badge variant="secondary" className="text-xs">
                          {event.type}
                        </Badge>
                        {event.correlationId && (
                          <span className="text-xs text-muted-foreground font-mono">
                            corr: {event.correlationId.slice(0, 12)}...
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(event.createdAt)}
                      </span>
                    </div>
                  </CardHeader>
                  <CollapsibleContent>
                    <Separator />
                    <CardContent className="py-3 px-4">
                      {isJson ? (
                        <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap font-mono">
                          {formatted}
                        </pre>
                      ) : (
                        <p className="text-sm whitespace-pre-wrap">
                          {event.payload}
                        </p>
                      )}
                      {event.metadata && (
                        <div className="mt-2">
                          <span className="text-xs text-muted-foreground">
                            Metadata:
                          </span>
                          <pre className="text-xs bg-muted p-2 rounded-md mt-1 overflow-x-auto font-mono">
                            {event.metadata}
                          </pre>
                        </div>
                      )}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            );
          })}
          <div ref={eventsEndRef} />
        </div>
      )}
    </div>
  );
}
