import { useEffect, useRef, useCallback, useState } from 'react';

type MessageHandler = (data: unknown) => void;

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface UseWebSocketReturn {
  status: ConnectionStatus;
  subscribe: (type: string, handler: MessageHandler) => () => void;
}

/**
 * WebSocket connection hook for the coordinator's real-time event stream.
 * Auto-reconnects with exponential backoff.
 */
export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const reconnectDelayRef = useRef(1000);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('connected');
      reconnectDelayRef.current = 1000; // Reset backoff
    };

    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        const { type } = message;

        // Dispatch to registered handlers
        const typeHandlers = handlersRef.current.get(type);
        if (typeHandlers) {
          for (const handler of typeHandlers) {
            handler(message);
          }
        }

        // Also dispatch to wildcard handlers
        const wildcardHandlers = handlersRef.current.get('*');
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) {
            handler(message);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      wsRef.current = null;

      // Schedule reconnect with exponential backoff
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 30000);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnect is handled there
    };

    wsRef.current = ws;
  }, []);

  const subscribe = useCallback(
    (type: string, handler: MessageHandler): (() => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);

      // Ensure connection is active
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
      }

      // Return unsubscribe function
      return () => {
        const typeHandlers = handlersRef.current.get(type);
        if (typeHandlers) {
          typeHandlers.delete(handler);
          if (typeHandlers.size === 0) {
            handlersRef.current.delete(type);
          }
        }
      };
    },
    [connect]
  );

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status, subscribe };
}
