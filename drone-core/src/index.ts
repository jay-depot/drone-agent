export type DronePluginDependency = {
  id: string;
  version?: string;
};

export type DronePluginMetadata = {
  id: string;
  name: string;
  version: string;
  description: string;
  required?: boolean;
  defaultEnabled?: boolean;
  dependencies?: DronePluginDependency[];
};

export type DroneOllamaConfig = {
  host: string;
  model: string;
};

export type DroneSessionConfig = {
  contextWindowTokens: number;
  responseReserveTokens: number;
  /**
   * Maximum number of model round-trips (each round-trip may include one or
   * more tool calls) before the conversation loop aborts with a "tool call
   * depth exceeded" error. Default is 50; the older hard-coded value was 8.
   *
   * This is a safety net against runaway loops, not a meaningful budget —
   * 50 round-trips at typical ollama latency is roughly a few minutes of
   * wall-clock time, and most well-formed agent tasks complete in 3-10.
   */
  maxToolIterations: number;
};

export type DroneCompactionStrategy = 'summary-drop';

export type DroneCompactionConfig = {
  enabled: boolean;
  strategy: DroneCompactionStrategy;
  softThresholdPercent: number;
  slicePercent: number;
  minTurnsToCompact: number;
  summaryMaxTokens: number;
  summaryBudgetPercent: number;
};

export type DroneLspSpawnServerConfig = {
  transport?: 'stdio';
  language?: string;
  command: string;
  args?: string[];
  fileExtensions?: string[];
  rootPatterns?: string[];
};

export type DroneLspExternalServerConfig = {
  transport: 'tcp';
  language?: string;
  host: string;
  port: number;
  fileExtensions?: string[];
  rootPatterns?: string[];
};

export type DroneLspServerConfig =
  | DroneLspSpawnServerConfig
  | DroneLspExternalServerConfig;

export type DroneLspConfig = {
  enabled: boolean;
  diagnosticTokenBudget: number;
  requestTimeoutMs: number;
  preferExternal: boolean;
  servers: Record<string, DroneLspServerConfig>;
};

export type DroneMcpStdioServerConfig = {
  transport?: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  requestTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  maxListPages?: number;
  maxListItems?: number;
};

export type DroneMcpStreamableHttpServerConfig = {
  transport: 'streamable_http';
  url: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  requestTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  maxListPages?: number;
  maxListItems?: number;
  compatibilityMode?: 'strict' | 'permissive';
};

export type DroneMcpServerConfig =
  | DroneMcpStdioServerConfig
  | DroneMcpStreamableHttpServerConfig;

export type DroneMcpConfig = {
  enabled: boolean;
  requestTimeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  maxListPages: number;
  maxListItems: number;
  compatibilityMode: 'strict' | 'permissive';
  servers: Record<string, DroneMcpServerConfig>;
};

export type DroneAgentConfig = {
  enabledPlugins: string[];
  systemPrompt: string;
  activePersona: string | null;
  ollama: DroneOllamaConfig;
  session: DroneSessionConfig;
  lsp: DroneLspConfig;
  mcp: DroneMcpConfig;
  compaction: DroneCompactionConfig;
};

export type PartialDroneAgentConfig = Partial<{
  enabledPlugins: string[];
  systemPrompt: string;
  activePersona: string | null;
  ollama: Partial<DroneOllamaConfig>;
  session: Partial<DroneSessionConfig>;
  lsp: Partial<DroneLspConfig>;
  mcp: Partial<DroneMcpConfig>;
  compaction: Partial<DroneCompactionConfig>;
}>;

export type DroneConfigScope = 'default' | 'user' | 'project';

export type DroneConfigLayer = {
  scope: DroneConfigScope;
  path?: string;
  config: PartialDroneAgentConfig;
};

export type DroneResolvedConfig = {
  config: DroneAgentConfig;
  layers: DroneConfigLayer[];
};

export type DroneSessionPhase =
  | 'plugins-loaded'
  | 'session-start'
  | 'before-prompt'
  | 'after-tool-call'
  | 'shutdown';

export type DroneLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type DroneToolJsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
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

export type DroneLspPosition = {
  line: number;
  character: number;
};

export type DroneLspRange = {
  start: DroneLspPosition;
  end: DroneLspPosition;
};

export type DroneLspDiagnostic = {
  filePath: string;
  range: DroneLspRange;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  code?: string;
};

export type DroneLspHoverResult = {
  filePath: string;
  line: number;
  column: number;
  contents: string;
  range?: DroneLspRange;
};

export type DroneLspServerState = {
  id: string;
  language: string;
  transport: 'stdio' | 'tcp';
  ownership: 'spawned' | 'external';
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  detail: string;
  lastError?: string;
};

export type DroneMcpServerState = {
  id: string;
  transport: 'stdio' | 'streamable_http';
  ownership: 'spawned' | 'external';
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  detail: string;
  discoveredToolCount: number;
  mountedToolCount: number;
  filteredToolCount: number;
  toolsListTruncated?: boolean;
  resourcesListTruncated?: boolean;
  promptsListTruncated?: boolean;
  compatibilityMode?: 'strict' | 'permissive';
  retryCount: number;
  retryAttemptCount: number;
  lastErrorCategory?:
    | 'transport'
    | 'timeout'
    | 'protocol'
    | 'payload'
    | 'unknown';
  lastError?: string;
};

export type DroneMcpMountedToolMeta = {
  serverId: string;
  originalName: string;
  description?: string;
};

export type DroneMcpPromptArgument = {
  name: string;
  required?: boolean;
  description?: string;
};

export type DroneMcpPromptMeta = {
  name: string;
  description?: string;
  arguments?: DroneMcpPromptArgument[];
};

export type DroneMcpResourceMeta = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type DronePersonaDefinition = {
  id: string;
  name: string;
  description: string;
  systemPromptOverride?: string;
  promptFragments?: string[];
  /**
   * Optional TUI color tint. When the persona is active, the TUI cycles
   * this color in as a tint over the base grayscale theme. Any blessed-
   * compatible color string works (named, hex, or 256-color code).
   */
  uiColor?: string;
};

export type DroneMcpError = {
  code: string;
  message: string;
  serverId?: string;
  data?: unknown;
};

export type DroneLlmProvider = {
  chat: (input: {
    model: string;
    messages: DroneChatMessage[];
    tools?: DroneToolDescriptor[];
  }) => Promise<DroneChatResponse>;
  getContextWindowInfo?: (input: {
    model: string;
  }) => Promise<DroneContextWindowInfo | null>;
};

export type DroneToolDefinition = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  execute: (input: Record<string, unknown>) => Promise<string>;
};

export type DronePromptFragment = {
  key: string;
  phase: 'header' | 'footer';
  render: () => Promise<string | false>;
};

export type DronePluginHooks = {
  onPluginsLoaded: (callback: () => Promise<void>) => void;
  onSessionStart: (callback: () => Promise<void>) => void;
  onBeforePrompt: (callback: () => Promise<void>) => void;
  onAfterToolCall: (callback: () => Promise<void>) => void;
  onShutdown: (callback: () => Promise<void>) => void;
  onSessionSafetyTrimWillRun: (
    callback: (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  ) => void;
  onSessionSafetyTrimApplied: (
    callback: (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  ) => void;
};

export type DronePluginRegistration = {
  logger: DroneLogger;
  getConfig: () => DroneAgentConfig;
  registerTool: (tool: DroneToolDefinition) => void;
  registerPromptFragment: (fragment: DronePromptFragment) => void;
  registerHelp: (help: string) => void;
  hooks: DronePluginHooks;
  offer: <T>(capability: T) => void;
  request: <T>(pluginId: string) => T | undefined;
};

export type DronePlugin = {
  metadata: DronePluginMetadata;
  register: (registration: DronePluginRegistration) => Promise<void>;
};

export function createConsoleLogger(scope: string): DroneLogger {
  return {
    info: message => console.log(`[${scope}] ${message}`),
    warn: message => console.warn(`[${scope}] ${message}`),
    error: message => console.error(`[${scope}] ${message}`),
  };
}

export function getCanonicalToolName(
  pluginId: string,
  toolName: string
): string {
  return `${pluginId}.${toolName}`;
}

export function createDefaultAgentConfig(): DroneAgentConfig {
  return {
    enabledPlugins: [],
    systemPrompt:
      'You are a coding agent. Prefer small, focused changes. Use the available tools; do not guess paths or contents.',
    activePersona: null,
    ollama: {
      host: 'http://127.0.0.1:11434',
      model: 'llama3.1',
    },
    session: {
      contextWindowTokens: 32768,
      responseReserveTokens: 4096,
      maxToolIterations: 50,
    },
    lsp: {
      enabled: true,
      diagnosticTokenBudget: 500,
      requestTimeoutMs: 5000,
      preferExternal: false,
      servers: {},
    },
    mcp: {
      enabled: true,
      requestTimeoutMs: 10000,
      retryCount: 1,
      retryDelayMs: 200,
      maxListPages: 25,
      maxListItems: 500,
      compatibilityMode: 'strict',
      servers: {},
    },
    compaction: {
      enabled: true,
      strategy: 'summary-drop',
      softThresholdPercent: 75,
      slicePercent: 25,
      minTurnsToCompact: 4,
      summaryMaxTokens: 800,
      summaryBudgetPercent: 20,
    },
  };
}

export function applyAgentConfigLayer(
  baseConfig: DroneAgentConfig,
  layer: PartialDroneAgentConfig
): DroneAgentConfig {
  return {
    enabledPlugins: layer.enabledPlugins ?? baseConfig.enabledPlugins,
    systemPrompt: layer.systemPrompt ?? baseConfig.systemPrompt,
    activePersona:
      layer.activePersona !== undefined
        ? layer.activePersona
        : baseConfig.activePersona,
    ollama: layer.ollama
      ? {
          ...baseConfig.ollama,
          ...layer.ollama,
        }
      : baseConfig.ollama,
    session: layer.session
      ? {
          ...baseConfig.session,
          ...layer.session,
        }
      : baseConfig.session,
    lsp: layer.lsp
      ? {
          ...baseConfig.lsp,
          ...layer.lsp,
          servers: layer.lsp.servers ?? baseConfig.lsp.servers,
        }
      : baseConfig.lsp,
    mcp: layer.mcp
      ? {
          ...baseConfig.mcp,
          ...layer.mcp,
          servers: layer.mcp.servers ?? baseConfig.mcp.servers,
        }
      : baseConfig.mcp,
    compaction: layer.compaction
      ? {
          ...baseConfig.compaction,
          ...layer.compaction,
        }
      : baseConfig.compaction,
  };
}

export {
  estimateSessionBudget,
  estimateMessageTokens,
  estimateTurnTokens,
  estimateToolDescriptorTokens,
  estimateTextTokens,
} from './token-estimate.js';
