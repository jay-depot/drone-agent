// === Service Adapter Interface ===

export interface DroneServiceAdapter {
  id: string;
  type: string; // "matrix", "telegram", "slack"
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  onMessage(handler: (message: AdapterMessage) => void): void;
}

export interface AdapterMessage {
  adapterId: string;
  conversationId: string;
  text: string;
  senderId?: string;
  senderName?: string;
}

// === Control Surface Interface ===

export interface DroneControlSurface {
  id: string;
  type: string; // "persona-assignment", "swarm-console", "mention-router", "discard"
  handleMessage(
    message: AdapterMessage
  ): Promise<{ response: string | null; handled: boolean }>;
}

// === Control Surface Spec (per-conversation config) ===

/**
 * Describes a single control surface to instantiate for a conversation.
 * The engine creates a dedicated instance per conversation.
 */
export interface ControlSurfaceSpec {
  type: string; // "persona-assignment", "swarm-console", "mention-router", "discard"
  personaId?: string; // for persona-assignment
  config?: Record<string, unknown>; // future surface-specific options
}

// === Resolved Service Adapter (post-config-load) ===

/**
 * A fully resolved service adapter with its conversation routing table.
 * The adapter owns conversation routing — it determines the conversationId
 * for each incoming message. Control surfaces are instantiated per conversation
 * and never need to know whether they're in a DM, a room, or the wildcard.
 */
export interface ResolvedServiceAdapter {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /**
   * Map of conversationId → ordered list of control surface specs.
   * Key "*" is the per-adapter wildcard catch-all, evaluated last.
   */
  conversations: Map<string, ControlSurfaceSpec[]>;
}

// === Config Types ===

export type SpawnBackendType = 'local' | 'coordinator';

export interface GatewayConfig {
  coordinatorUrl: string;
  coordinatorToken?: string;
  spawnBackend: SpawnBackendType;
  agentPath?: string; // path to drone-agent binary (local mode)
  serviceAdapters: ResolvedServiceAdapter[];
}

// === Markdown Renderer Interface ===

export interface RenderedMessage {
  body: string;
  formattedBody: string | null; // null if rendering failed (fallback to plain)
}

export interface MarkdownRenderer {
  render(md: string): RenderedMessage;
}

// === Spawn Backend Types ===

/**
 * Represents a persistent agent session managed by a SpawnBackend.
 * The session tracks the agent process and the conversation it serves.
 */
export interface SpawnSession {
  conversationId: string;
  personaId: string;
  processId: string; // opaque identifier for the backend
  startedAt: number;
}
