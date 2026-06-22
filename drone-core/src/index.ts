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
  /**
   * When true, the host prompts the user to continue when the tool
   * iteration limit is reached, instead of aborting with a hard error.
   * The user can choose to continue (resets the counter) or stop.
   * Defaults to false (hard error).
   */
  promptOnToolIterationLimit?: boolean;
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

export type DroneMemoryConfig = {
  enabled: boolean;
  /** Max number of memory entries before oldest are pruned. 0 = unlimited. */
  maxEntries: number;
  /** Auto-save session summary on shutdown. */
  autoSave: boolean;
};

export type DroneLspSpawnServerConfig = {
  transport?: 'stdio';
  language?: string;
  command: string;
  args?: string[];
  fileExtensions?: string[];
  rootPatterns?: string[];
  /**
   * When true, the LSP plugin will attempt to download a pinned copy of the
   * server into a per-user cache and invoke it via Node if `command`
   * isn't on PATH. Defaults to the top-level `lsp.autoInstall` value
   * (true). When false, the plugin never auto-installs — only
   * user-installed servers are used.
   */
  autoInstall?: boolean;
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
  /**
   * When true (default), the LSP plugin will lazily download a known
   * server into a per-user cache if it can't be found on PATH. Set to
   * false to disable auto-installation entirely.
   */
  autoInstall: boolean;
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
  memory: DroneMemoryConfig;
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
  memory: Partial<DroneMemoryConfig>;
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
  /**
   * Where the running command came from. `'path'` means the user's
   * installed binary on PATH; `'cache'` means the auto-installed copy
   * in `~/.cache/drone-agent/lsp/...`.
   */
  installSource?: 'path' | 'cache';
  /**
   * Lifecycle of the auto-install step for this server. `'unused'`
   * means the server was found on PATH or auto-install is disabled;
   * `'cached'` means a previous install was reused; `'downloaded'`
   * means we just fetched it for the first time; `'failed'` means
   * the download/extract/integrity step failed and the server is
   * offline.
   */
  installStatus?: 'unused' | 'cached' | 'downloaded' | 'failed';
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

/**
 * The set of hook names that `engine.runHooks` accepts — all
 * `DronePluginHooks` keys except the safety-trim hooks (which use
 * their own dedicated engine methods with payloads).
 */
export type DroneStandardHookName = Exclude<
  keyof DronePluginHooks,
  'onSessionSafetyTrimWillRun' | 'onSessionSafetyTrimApplied'
>;

export type DronePluginRegistration = {
  logger: DroneLogger;
  getConfig: () => DroneAgentConfig;
  registerTool: (tool: DroneToolDefinition) => void;
  registerPromptFragment: (fragment: DronePromptFragment) => void;
  registerHelp: (help: string) => void;
  registerWorkflow: (workflow: DroneWorkflow) => void;
  /**
   * Register a slash command handler. When the user enters a line
   * starting with `command` (e.g. `/persona`), the engine dispatches
   * to the handler instead of the host's hardcoded dispatch chain.
   * Multiple plugins may register different commands; only commands
   * from enabled plugins are dispatched.
   */
  registerSlashCommand: (command: DroneSlashCommand) => void;
  hooks: DronePluginHooks;
  offer: <T>(capability: T) => void;
  request: <T>(pluginId: string) => T | undefined;
  /**
   * Run a workflow registered by any plugin. Used by tools that
   * want to delegate to a workflow so all entry points share one
   * implementation. Returns the same shape as `DronePluginEngine.runWorkflow`.
   */
  runWorkflow: (
    canonicalName: string,
    args: Record<string, unknown>
  ) => Promise<DroneWorkflowResult>;
  /**
   * Returns the host's elicitation capability (set by the CLI shell or
   * the TUI at engine init time). Lets plugins ask the user structured
   * questions (closed-set or freeform) without coupling to a host.
   * Returns `undefined` in non-interactive modes (e.g. `--once`).
   */
  requestElicitation: () => DroneElicitation | undefined;
};

// ---------------------------------------------------------------------------
// Elicitation: plugin-driven interactive prompts
// ---------------------------------------------------------------------------

export type DroneElicitationQuestionChoice = {
  value: string;
  label: string;
};

/**
 * One question for the host to render. Exactly one of `choices` or
 * `freeform: true` must be set. Hosts validate this at `ask()` time.
 */
export type DroneElicitationQuestion = {
  id: string;
  prompt: string;
  /** Closed-set answers. Omit (and set `freeform: true`) for open text. */
  choices?: DroneElicitationQuestionChoice[];
  /** When true, accept arbitrary text input. Mutually exclusive with `choices`. */
  freeform?: boolean;
  placeholder?: string;
  /** For closed-set: returned on empty input. For freeform: returned on empty input. */
  defaultValue?: string;
  /**
   * Optional short label printed before the user's response (readline host).
   * The TUI host renders the prompt inline and ignores this field.
   */
  inputLabel?: string;
};

/** Answers keyed by question id. Always strings. */
export type DroneElicitationAnswers = Record<string, string>;

export type DroneElicitation = {
  ask: (
    questions: DroneElicitationQuestion[]
  ) => Promise<DroneElicitationAnswers>;
};

// ---------------------------------------------------------------------------
// Workflows: long-running, multi-step plugin entry points
// ---------------------------------------------------------------------------

/**
 * Context passed to a workflow's `run` function. Bundles everything a
 * workflow commonly needs (elicitation, project dir, config, and a way to
 * resolve other plugin capabilities) without leaking the raw engine handle.
 */
export type DroneWorkflowContext = {
  elicit: DroneElicitation;
  projectDir: string;
  config: DroneAgentConfig;
  /**
   * Re-exposed reference to `registration.request`. Lets a workflow resolve
   * another plugin's capability (e.g. the `ollama` provider) without
   * needing the engine handle directly.
   */
  requestCapability: <T>(pluginId: string) => T | undefined;
};

/**
 * Workflows may return any of these shapes; the engine normalizes them.
 *   - object with `kickMessage`/`toolResult`: pass through.
 *   - string: treated as `toolResult`.
 *   - void / undefined: `{ toolResult: '{}' }`.
 *   - raw object: serialized as `{ toolResult: JSON.stringify(obj) }`.
 */
export type DroneWorkflowResult = {
  /** If set, the engine injects this as a synthetic user turn and re-enters the chat loop. */
  kickMessage?: string;
  /** Human-readable JSON for the tool caller. Defaults to '{}' if the workflow produces nothing else. */
  toolResult?: string;
};

export type DroneWorkflowRunReturn =
  | DroneWorkflowResult
  | void
  | string
  | Record<string, unknown>;

export type DroneWorkflow = {
  /** Unique within the registering plugin. */
  name: string;
  description: string;
  /** Documents the input args the workflow accepts; surfaced as `--workflow-arg key=value` help. */
  inputSchema?: DroneToolJsonSchema;
  run: (
    input: Record<string, unknown>,
    ctx: DroneWorkflowContext
  ) => Promise<DroneWorkflowRunReturn> | DroneWorkflowRunReturn;
};

// ---------------------------------------------------------------------------
// Slash commands: plugin-registered interactive command handlers
// ---------------------------------------------------------------------------

/**
 * Context passed to a slash command handler. Bundles the host-side
 * services a handler needs (engine for tool execution/capabilities,
 * conversation for model switching, session manager, and a logger)
 * without the handler needing to import host types directly.
 *
 * The host (CLI or TUI) constructs this context at dispatch time.
 */
export type DroneSlashCommandContext = {
  /** The full raw line the user entered, including the leading slash command. */
  line: string;
  /** The subcommand arguments after the command string, split by whitespace. */
  args: string[];
  /** Logger for user-facing output (info/warn/error). */
  logger: DroneLogger;
  /** Engine handle for executing tools, running workflows, accessing capabilities. */
  engine: {
    executeTool: (
      canonicalName: string,
      input: Record<string, unknown>
    ) => Promise<string>;
    /** Optional — may be absent in minimal hosts. */
    runWorkflow?: (
      canonicalName: string,
      args: Record<string, unknown>
    ) => Promise<DroneWorkflowResult>;
    runHooks: (hookName: DroneStandardHookName) => Promise<void>;
    getCapability: <T>(pluginId: string) => T | undefined;
  };
  /**
   * Conversation service for model management. Optional — hosts
   * that don't expose model switching (e.g. non-interactive) may omit.
   */
  conversation?: {
    getModel: () => string;
    setModel: (model: string) => void;
    sendUserMessage: (
      prompt: string,
      onEvent?: (event: unknown) => void
    ) => Promise<string>;
  };
  /** Session manager for appending synthetic user messages. */
  sessionManager?: {
    appendUserMessage: (message: string) => void;
  };
};

/**
 * A plugin-registered slash command. When the user enters a line
 * starting with `command` (e.g. `/persona`), the engine dispatches to
 * `handler` with a context carrying the raw line, engine, conversation,
 * and other host services.
 */
export type DroneSlashCommand = {
  /** The command string including leading slash, e.g. `/persona` or `/model`. */
  command: string;
  /** Description for help output. */
  description: string;
  /**
   * Handler invoked when the user enters a line starting with `command`.
   * Receives the full raw line and host-side services. Return `true` if
   * the command was handled; `false` to fall through to the next handler.
   */
  handler: (ctx: DroneSlashCommandContext) => Promise<boolean>;
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
      promptOnToolIterationLimit: false,
    },
    lsp: {
      enabled: true,
      diagnosticTokenBudget: 500,
      requestTimeoutMs: 5000,
      preferExternal: false,
      autoInstall: true,
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
    memory: {
      enabled: true,
      maxEntries: 0,
      autoSave: true,
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
    memory: layer.memory
      ? {
          ...baseConfig.memory,
          ...layer.memory,
        }
      : baseConfig.memory,
  };
}

export {
  estimateSessionBudget,
  estimateMessageTokens,
  estimateTurnTokens,
  estimateToolDescriptorTokens,
  estimateTextTokens,
} from './token-estimate.js';
