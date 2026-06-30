// Types matching the coordinator's API responses

export interface Beacon {
  id: string;
  name: string;
  host: string;
  port: number;
  connectedAt: number;
  lastHeartbeat: number;
  trustStatus?: 'pending' | 'approved' | 'rejected' | null;
  publicKey?: string | null;
}

export interface AgentLocation {
  agentId: string;
  beaconId: string;
  personaId: string | null;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface BeaconSession {
  id: string;
  beaconId: string;
  agentId: string;
  personaId: string | null;
  connectedAt: number;
  disconnectedAt: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
  beaconName?: string;
  beaconHost?: string;
  beaconPort?: number;
}

export interface SwarmEvent {
  id: string;
  sessionId: string;
  correlationId: string | null;
  type: string;
  payload: string | null;
  metadata: string | null;
  createdAt: number;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageMeta {
  id: string;
  title: string;
  scope: string;
  tags: string[];
  sources: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WikiPage extends WikiPageMeta {
  content: string;
}

// WebSocket message types
export interface WsInitialMessage {
  type: 'initial';
  data: {
    beacons: Beacon[];
    agentLocations: AgentLocation[];
    sessions: BeaconSession[];
  };
}

export interface WsEventMessage {
  type: 'event';
  sessionId: string;
  eventType: string;
  payload?: unknown;
}

export interface WsPingMessage {
  type: 'ping';
}

export type WsMessage = WsInitialMessage | WsEventMessage | WsPingMessage;
