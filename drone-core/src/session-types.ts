// ── Session types ────────────────────────────────────────────────────

/**
 * Session lifecycle statuses for the swarm session processing pipeline.
 * Used by the coordinator to track the state of each swarm session.
 */
export const SESSION_STATUSES = {
  ACTIVE: 'active',
  STALE: 'stale',
  ENDED: 'ended',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  ARCHIVED: 'archived',
} as const;

/** Union type of all session status values. */
export type SessionStatus =
  (typeof SESSION_STATUSES)[keyof typeof SESSION_STATUSES];

export type DroneLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type DroneToolJsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  properties?: Record<string, DroneToolJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: DroneToolJsonSchemaProperty;
};

export type DroneToolJsonSchema = {
  readonly type: 'object';
  readonly properties?: Record<string, DroneToolJsonSchemaProperty>;
  readonly required?: string[];
  readonly additionalProperties?: boolean;
};

export type DroneImageContent = {
  /** MIME type of the image (e.g. "image/jpeg", "image/png"). */
  mimeType: string;
  /** Base64-encoded image data (without the data: URI prefix). */
  data: string;
  /**
   * Model-generated description of the image, used as the wire representation
   * when the target model is not vision-capable. Stored as part of the
   * abstract context.
   */
  description?: string;
};

/**
 * Structured result a tool may return in place of a plain string. When a tool
 * returns a `DroneToolResult`, the base64 image data must live ONLY in
 * `images[]` (never in `content`), so the images channel is the single source
 * of truth and the content string stays small enough for token estimation and
 * wire transmission.
 *
 * The string form of a tool result is a first-class "text-only" equivalent of
 * this type with no images. Tools may keep returning plain strings; only
 * image-producing tools need the structured form.
 */
export type DroneToolResult = {
  /** Human-readable text for the LLM. Must NOT contain base64 image data. */
  content: string;
  /** Structured images carried out-of-band from the content string. */
  images?: DroneImageContent[];
};

export type DroneChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: DroneImageContent[];
  toolCallId?: string;
  toolName?: string;
  toolCalls?: DroneToolCall[];
};

export type DroneSessionMessage = DroneChatMessage;

export type DroneSessionTurn = {
  id: string;
  messages: DroneSessionMessage[];
  kind?: 'summary';
};

export type DroneToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type DroneToolDescriptor = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  /**
   * If true, this tool is hidden from the LLM by default unless the active
   * persona explicitly includes it via `allowedTools`. Propagated from
   * `DroneToolDefinition.defaultHidden` through the plugin engine.
   */
  defaultHidden?: boolean;
};

export type DroneChatResponse = {
  message?: string;
  reasoning?: string;
  toolCalls?: DroneToolCall[];
};

/**
 * Provenance of a context-window size. `provider` = live probe against the
 * provider (e.g. ollama `client.show()`), `metadata` = declared or discovered
 * catalog data resolved broker-side, `config` = session fallback
 * (`session.contextWindowTokens`), `default` = driver hardcoded default.
 *
 * `detail` is optional driver-resolved slot provenance (e.g. which ollama
 * source supplied the window: resident ps truth, request num_ctx, Modelfile,
 * driver pin). Human-readable only — consumers must not switch on it; it is
 * never set on the broker's metadata/config resolution paths.
 */
export type DroneContextWindowInfo = {
  model: string;
  contextWindowTokens: number;
  source: 'provider' | 'config' | 'default' | 'metadata';
  detail?: string;
};

export type DroneTokenEstimate = {
  estimatedSystemTokens: number;
  estimatedSessionTokens: number;
  estimatedToolTokens: number;
  estimatedPromptTokens: number;
  reservedResponseTokens: number;
  estimatedTotalTokens: number;
  contextWindowTokens: number;
  maxPromptTokens: number;
  requiresSafetyTrim: boolean;
};

export type DroneSessionSafetyTrimPayload = {
  model: string;
  contextWindow: DroneContextWindowInfo;
  budget: DroneTokenEstimate;
  currentTurns: DroneSessionTurn[];
  proposedDropTurnCount: number;
  droppedTurns?: DroneSessionTurn[];
  warningMessage?: string;
};

/** State passed to a custom tool render component in the TUI tail region. */
export type ToolRenderState = {
  name: string;
  arguments: Record<string, unknown>;
  /** Present when the tool has completed (success or error). */
  result?: string;
  status: 'running' | 'done' | 'error';
  /** TUI color scheme, cast to unknown to keep drone-core React-free. */
  scheme: unknown;
  /** Accumulated streaming output lines emitted via onProgress during execution. */
  outputLines?: string[];
  /** User-configured syntax highlighting colors (from tui.syntaxHighlighting.colors). */
  syntaxColors?: Record<string, string>;
  /** User-configured code background color (from tui.syntaxHighlighting.codeBackground). */
  codeBackground?: string;
  /** Terminal columns at render time, so width-aware components (e.g. code
   * background padding) can compute wrap-correct line fills. */
  columns?: number;
};

export type DroneConversationEvent =
  | { kind: 'userMessage'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'reasoningComplete' }
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'assistantMessageComplete' }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | {
      kind: 'toolCallBatch';
      toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    }
  | {
      kind: 'toolResult';
      name: string;
      content: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: 'toolResultBatch';
      results: Array<{
        name: string;
        content: string;
        arguments: Record<string, unknown>;
      }>;
    }
  | { kind: 'toolProgress'; name: string; content: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'compaction';
      message: string;
      status: 'started' | 'completed' | 'failed';
    }
  /**
   * Emitted once when a round (one sendUserMessage call) fully completes,
   * including on cancellation and error exits. It is a silent control signal
   * for plugins (e.g. wakelock) — it carries no message and intentionally has
   * no TUI/theme rendering.
   */
  | { kind: 'roundComplete' }
  | {
      kind: 'notice';
      content: string;
    }
  /**
   * Session-parameter / lifecycle events. These are emitted by plugins (via
   * `registration.emitEvent`) outside a conversation round and intentionally
   * carry no correlationId, so each surfaces as its own standalone line in the
   * coordinator's readable transcript rather than being folded into a turn.
   */
  | { kind: 'personaChanged'; from: string | null; to: string | null }
  | { kind: 'focusChanged'; focus: string | null }
  | { kind: 'macroExecuted'; command: string }
  | {
      kind: 'sessionStarted';
      subagentId: string | null;
      personaId: string | null;
    };
