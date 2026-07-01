// ── Session types ────────────────────────────────────────────────────

/**
 * Session lifecycle statuses for the swarm session processing pipeline.
 * Used by the coordinator to track the state of each swarm session.
 */
export const SESSION_STATUSES = {
  ACTIVE: 'active',
  STALE: 'stale',
  FINISHED: 'finished',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
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

export type DroneChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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

export type DroneSessionState = {
  messages: DroneSessionMessage[];
  turns: DroneSessionTurn[];
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

export type DroneContextWindowInfo = {
  model: string;
  contextWindowTokens: number;
  source: 'provider' | 'config' | 'default';
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

export type DroneConversationEvent =
  | { kind: 'userMessage'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | {
      kind: 'toolResult';
      name: string;
      content: string;
      arguments: Record<string, unknown>;
    }
  | { kind: 'error'; message: string };
