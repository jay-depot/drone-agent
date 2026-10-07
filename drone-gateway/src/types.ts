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
  /**
   * Whether this conversation is a 1:1 DM or a multi-user room. Computed by the
   * adapter (it owns conversation routing); the gateway never inspects the id.
   */
  conversationKind: 'dm' | 'room';
}

// === Control Surface Interface ===

export interface DroneControlSurface {
  id: string;
  type: string; // "persona-assignment", "swarm-console", "mention-router", "discard"
  handleMessage(
    message: AdapterMessage
  ): Promise<{ response: string | null; handled: boolean }>;
  /**
   * Batch-eligible surfaces implement this. When present on a conversation's
   * sole surface, incoming messages are buffered and delivered here as one
   * ordered batch (see MessageBatcher). Absence = immediate per-message path.
   */
  handleBatch?(
    messages: AdapterMessage[]
  ): Promise<{ response: string | null; handled: boolean }>;
  /**
   * Called once by the engine at shutdown, after adapters stop. Implementations
   * must be idempotent and must not throw (the engine logs and swallows).
   */
  dispose?(): Promise<void>;
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
   * Map of conversationId → resolved conversation.
   * Key "*" is the per-adapter wildcard catch-all, evaluated last.
   */
  conversations: Map<string, ResolvedConversation>;
}

/**
 * A conversation's control surface specs plus its optional sender allowlist.
 * When `allowedSenders` is set, the engine only dispatches to this
 * conversation for senders in the list; other senders fall through to the
 * wildcard. Unset means every sender is allowed.
 */
export interface ResolvedConversation {
  allowedSenders?: string[];
  surfaces: ControlSurfaceSpec[];
}

// === Config Types ===

export type SpawnBackendType = 'local' | 'coordinator';

export interface GatewayConfig {
  coordinatorUrl: string;
  coordinatorToken?: string;
  spawnBackend: SpawnBackendType;
  /**
   * Gateway-wide default beacon for coordinator-mode spawns. Required when
   * `spawnBackend` is "coordinator"; inert (and warned about) in local mode.
   */
  targetBeaconId?: string;
  /**
   * Gateway-wide default idle timeout (ms) for spawning control surfaces.
   * A surface-level `config.lifecycle.idleTimeoutMs` overrides it; `0` disables.
   */
  idleTimeoutMs?: number;
  /**
   * Gateway-wide default batch debounce (ms) for batching control surfaces.
   * A surface-level `config.batch.debounceMs` overrides it; `0` disables the
   * debounce (flush on the next tick).
   */
  batch?: { debounceMs?: number };
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
  /** The beacon the spawn was placed on. Coordinator mode only. */
  targetBeaconId?: string;
  /**
   * The beacon's spawn-record id (the `spawns.id` row key). Coordinator mode
   * only. The terminate endpoint is keyed on THIS, not on `processId` (which
   * is the agentId and is used for message relay).
   */
  spawnId?: string;
  /** The working directory the spawn was placed with. Absent = mode default. */
  workingDir?: string;
}

export interface SpawnSessionOptions {
  /** Beacon to spawn on. Required in coordinator mode. */
  targetBeaconId?: string;
  /**
   * Working directory for the spawned agent. Local mode uses it as the child
   * cwd; coordinator mode forwards it as the beacon's `config.workingDir`
   * (subject to the beacon's spawnRoots whitelist).
   */
  workingDir?: string;
}
