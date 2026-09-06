// Types matching the coordinator's API responses

export interface Beacon {
  id: string;
  name: string;
  host: string;
  port: number;
  connected?: boolean;
  connectedAt: number;
  lastHeartbeat: number;
  trustStatus?: 'pending' | 'approved' | 'rejected' | null;
  publicKey?: string | null;
  verificationCode?: string | null;
}

export interface BeaconDetail extends Beacon {
  beaconId?: string;
  tlsFingerprint?: string | null;
  verificationCode?: string | null;
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

export interface SwarmSession {
  id: string;
  personaId: string | null;
  beaconId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
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

export interface CreatePersonaRequest {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope?: string;
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

export interface CreateSkillRequest {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope?: string;
}

export interface WikiPageMeta {
  id: string;
  title: string;
  scope: string;
  tags: string[];
  sources: string[];
  pitch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPage extends WikiPageMeta {
  content: string;
}

export interface CreateWikiPageRequest {
  title: string;
  content: string;
  scope?: string;
  tags?: string[];
  sources?: string[];
  pitch?: string;
}

export interface WikiTagCount {
  tag: string;
  count: number;
}

export interface WikiGraphNode {
  id: string;
  title: string;
  exists: boolean;
  wordCount: number;
  tags: string[];
  pitch?: string;
  scope: string;
}

export interface WikiGraphEdge {
  source: string;
  target: string;
  kind: 'link';
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}

export type GraphNodeKind = 'page' | 'tag';

export type AugmentedGraphNode = WikiGraphNode & {
  kind: GraphNodeKind;
  /** force-graph nodeVal (area-proportional size); computed by applyNodeSizing. */
  _val?: number;
};

export type AugmentedGraphEdge = Omit<WikiGraphEdge, 'kind'> & {
  kind: 'link' | 'tag';
};

export interface AugmentedWikiGraph {
  nodes: AugmentedGraphNode[];
  edges: AugmentedGraphEdge[];
}

// Pagination types
export interface PaginationState {
  limit: number;
  offset: number;
  total?: number;
}

export interface PaginatedResponse<T> {
  sessions: T[];
  count: number;
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
