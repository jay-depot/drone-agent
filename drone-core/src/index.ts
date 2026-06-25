// ── Precedence constants for skill/persona/provider plugins ──────────
/** Precedence for swarm-level providers (highest priority — lowest number). */
export const PRECEDENCE_SWARM = 5000;
/** Precedence for coordinator-level providers. */
export const PRECEDENCE_COORDINATOR = 4000;
/** Precedence for user-level providers. */
export const PRECEDENCE_USER = 3000;
/** Precedence for skills owned by a user-level persona. */
export const PRECEDENCE_PERSONA_USER = 2500;
/** Precedence for project-level providers. */
export const PRECEDENCE_PROJECT = 2000;
/** Precedence for skills owned by a project-level persona. */
export const PRECEDENCE_PERSONA_PROJECT = 1500;
/** Precedence for LLM provider plugins (e.g. ollama, openrouter). */
export const PRECEDENCE_LLM_PROVIDER = 1000;

export type DronePluginDependency = {
  id: string;
  version?: string;
  /** When true, the plugin can still load if this dependency is missing or disabled. */
  optional?: boolean;
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

export type DroneLlmConfig = {
  /** The id of the active LLM provider plugin (e.g. 'ollama', 'openrouter'). */
  provider: string;
};

export type DroneOpenRouterModelConfig = {
  id: string;
  contextWindow: number;
};

export type DroneOpenRouterConfig = {
  apiKey: string;
  defaultModel: string;
  baseUrl: string;
  models: DroneOpenRouterModelConfig[];
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
};

export type DroneLogConfig = {
  enabled: boolean;
};

export type DronePromptFileConfig = {
  enabled: boolean;
  files: string[];
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
  /**
   * Wire encoding for stdio transport.
   * - `'content-length'` (default): standard MCP HTTP-style framing with
   *   `Content-Length` headers. Compatible with most MCP servers.
   * - `'line-delimited'`: one JSON object per line (newline-delimited JSON /
   *   NDJSON). Use for servers like Lightpanda that read stdin line-by-line
   *   instead of parsing Content-Length headers.
   */
  encoding?: 'content-length' | 'line-delimited';
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
  llm: DroneLlmConfig;
  ollama: DroneOllamaConfig;
  openrouter: DroneOpenRouterConfig;
  session: DroneSessionConfig;
  lsp: DroneLspConfig;
  mcp: DroneMcpConfig;
  compaction: DroneCompactionConfig;
  memory: DroneMemoryConfig;
  log: DroneLogConfig;
  promptFile: DronePromptFileConfig;
};

export type PartialDroneAgentConfig = Partial<{
  enabledPlugins: string[];
  systemPrompt: string;
  activePersona: string | null;
  llm: Partial<DroneLlmConfig>;
  ollama: Partial<DroneOllamaConfig>;
  openrouter: Partial<DroneOpenRouterConfig>;
  session: Partial<DroneSessionConfig>;
  lsp: Partial<DroneLspConfig>;
  mcp: Partial<DroneMcpConfig>;
  compaction: Partial<DroneCompactionConfig>;
  memory: Partial<DroneMemoryConfig>;
  log: Partial<DroneLogConfig>;
  promptFile: Partial<DronePromptFileConfig>;
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

// ── Skill definition (moved from drone-agent/src/plugins/skills/loader.ts) ──

export type DroneSkillDefinition = {
  id: string;
  name: string;
  description: string;
  recall: string[];
  modelInvocation: boolean;
  body: string;
  source: 'user' | 'project' | 'beacon' | 'coordinator';
  /** Precedence assigned by the provider. Lower number = higher priority. */
  precedence?: number;
  /**
   * If this skill is owned by a persona, the persona's id.
   * Set by the persona provider plugin when loading persona-owned skills.
   */
  personaId?: string;
};

// ── Provider types for skill/persona broker architecture ────────────

/**
 * A provider of skills registered with the skills broker plugin.
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DroneSkillProvider = {
  /** Unique id for this provider (e.g. 'skill-provider-project'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  precedence: number;
  /** Get all skills from this provider. */
  getSkills: () => DroneSkillDefinition[];
  /** Get a single skill by id, or undefined. */
  getSkill: (id: string) => DroneSkillDefinition | undefined;
  /** Reload skills from source (disk, network, etc.). */
  reloadSkills: () => Promise<void>;
};

/**
 * Callback invoked after a skill is recalled. Receives the skill id and
 * the current body text. Returns a modified body (or the original).
 */
export type DroneRecallEnhancer = (id: string, body: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Config Injector: hook system for injecting config as underlay
// ---------------------------------------------------------------------------

/**
 * A config injector that provides config values as an underlay.
 * Lower priority = runs first (underlay), higher priority = runs last (overlay).
 * Since beacon config is an underlay, it should have a lower priority than
 * the agent's local config (which wins for conflicts under "most local wins").
 */
export type DroneConfigInjector = {
  /** Unique identifier for this injector (e.g. 'beacon', 'coordinator'). */
  id: string;
  /**
   * Priority value. Lower number = runs first = underlay.
   * Recommended: coordinator=50, beacon=75, agent=100.
   */
  precedence: number;
  /** Inject config values that will be merged as underlay. */
  inject: () => Promise<PartialDroneAgentConfig>;
};

/**
 * Capability offered by the config system. Lets plugins register
 * config injectors that provide defaults (underlay) for the agent config.
 */
export type DroneConfigCapability = {
  /** Register a config injector. */
  registerInjector: (injector: DroneConfigInjector) => void;
  /** Unregister a config injector by id. */
  unregisterInjector: (injectorId: string) => void;
  /** Get all registered injectors sorted by precedence. */
  getInjectors: () => DroneConfigInjector[];
  /**
   * Rebuild the config by calling all injectors and merging results.
   * Returns the merged config.
   */
  rebuild: () => Promise<DroneAgentConfig>;
};

/**
 * Capability offered by the skills broker plugin. Lets other plugins
 * query skills, manage providers, and register recall enhancers.
 */
export type DroneSkillsCapability = {
  getSkills: () => DroneSkillDefinition[];
  getSkill: (id: string) => DroneSkillDefinition | undefined;
  reloadSkills: () => Promise<void>;
  registerProvider: (provider: DroneSkillProvider) => void;
  unregisterProvider: (providerId: string) => void;
  /** Register a callback that can enhance skill recall results. */
  onRecall: (enhancer: DroneRecallEnhancer) => void;
};

/**
 * A provider of personas registered with the persona broker plugin.
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DronePersonaProvider = {
  /** Unique id for this provider (e.g. 'persona-provider-project'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  precedence: number;
  /** Get all personas from this provider. */
  getPersonas: () => DronePersonaDefinition[];
  /** Get a single persona by id, or undefined. */
  getPersona: (id: string) => DronePersonaDefinition | undefined;
  /** Reload personas from source (disk, network, etc.). */
  reloadPersonas: () => Promise<void>;
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
  /**
   * The scope this persona was loaded from. `'user'` means it came from
   * `~/.drone-agent/personas/`, `'project'` means it came from
   * `<project>/.drone-agent/personas/`.
   */
  scope?: 'user' | 'project' | 'beacon' | 'coordinator';
  /**
   * Optional list of skill ids owned by this persona. Skills are loaded
   * from a `skills/` subdirectory relative to the persona file.
   * @deprecated Skills are now auto-detected from the skills/ subdirectory.
   */
  skillIds?: string[];
  /**
   * Optional glob patterns for filtering which tools the LLM sees when
   * this persona is active. Each pattern is matched against the canonical
   * tool name (e.g. `exec.run`, `mcp.filesystem.read`). Supports `*` and
   * `?` wildcards. Prefix a pattern with `!` to exclude matching tools.
   * When absent, all tools are visible.
   *
   * Example: `['exec.*', 'file.*', '!exec.run']`
   */
  allowedTools?: string[];
  /**
   * Optional glob patterns for filtering which global skills the LLM
   * sees when this persona is active. Each pattern is matched against
   * the skill id. Supports `*` and `?` wildcards. Prefix a pattern with
   * `!` to exclude matching skills. Persona-owned skills (from the
   * `skills/` subdirectory) are always visible regardless of this filter.
   * When absent, all global skills are visible.
   */
  allowedSkills?: string[];
  /**
   * Optional override for the chained tool call limit (session.maxToolIterations).
   * When set, this value is used instead of the configured limit while this
   * persona is active. Useful for personas that need many tool rounds (e.g.
   * a `code` persona) without raising the global safety limit.
   */
  toolCallLimit?: number;
};

/**
 * Capability offered by the persona broker plugin. Lets other plugins
 * query and manage personas, filter tools/skills, and react to persona
 * changes.
 */
export type DronePersonaCapability = {
  getActivePersona: () => DronePersonaDefinition | null;
  getPersonas: () => DronePersonaDefinition[];
  selectPersona: (id: string | null) => void;
  onPersonaChange: (
    callback: (persona: DronePersonaDefinition | null) => void
  ) => void;
  /**
   * Reload persona files from disk. Called by the persona.create
   * workflow after writing a new file, and exposed so other plugins
   * (or tests) can force a refresh.
   */
  reloadPersonas: () => Promise<void>;
  /** Register a persona provider. Providers are sorted by precedence (ascending). */
  registerProvider: (provider: DronePersonaProvider) => void;
  /** Unregister a persona provider by id. */
  unregisterProvider: (providerId: string) => void;
  /**
   * Filter a list of tool descriptors based on the active persona's
   * `allowedTools` patterns. Returns all tools when no persona is active
   * or when the persona has no `allowedTools` field.
   */
  getFilteredTools: (allTools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  /**
   * Filter a list of global skills based on the active persona's
   * `allowedSkills` patterns, then append persona-owned skills (which
   * are always visible). Returns all skills when no persona is active
   * or when the persona has no `allowedSkills` field.
   */
  getFilteredSkills: (
    allSkills: DroneSkillDefinition[]
  ) => DroneSkillDefinition[];
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

// ── LLM provider broker types ───────────────────────────────────────

/**
 * Registration for an LLM provider plugin (e.g. ollama, openrouter).
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DroneLlmProviderRegistration = {
  /** Unique id for this provider (e.g. 'ollama', 'openrouter'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  precedence: number;
  /** Get the DroneLlmProvider implementation. */
  getProvider: () => DroneLlmProvider;
  /** List available model identifiers. */
  listModels: () => Promise<string[]>;
  /** The default model to use when this provider is activated. */
  getDefaultModel: () => string;
};

/**
 * Capability offered by the LLM broker plugin. Lets other plugins and
 * the host resolve the active LLM provider and manage model selection.
 */
export type DroneLlmCapability = {
  /** Get the active DroneLlmProvider implementation. */
  getActiveProvider: () => DroneLlmProvider;
  /** Get the id of the active provider (e.g. 'ollama', 'openrouter'). */
  getActiveProviderId: () => string;
  /** Get the currently selected model name. */
  getModel: () => string;
  /** Set the currently selected model name. */
  setModel: (model: string) => void;
  /** List available models from the active provider. */
  listModels: () => Promise<string[]>;
  /** Register a provider. Providers are sorted by precedence (ascending). */
  registerProvider: (registration: DroneLlmProviderRegistration) => void;
  /** Unregister a provider by id. */
  unregisterProvider: (providerId: string) => void;
};

// ── Self-improvement types ────────────────────────────────────────────

/**
 * A single principle entry stored in a principles JSON file.
 * Principles are derived from patterns found in insights.
 */
export type DronePrincipleEntry = {
  /** The principle text. */
  principle: string;
  /** Optional description of where this principle came from. */
  source?: string;
  /** ISO-8601 timestamp of when this principle was created. */
  createdAt: string;
};

/**
 * Capability offered by the self-improvement plugin. Lets other plugins
 * (e.g. skills) read principles without coupling to the file system.
 */
export type DronePrinciplesCapability = {
  /** Get all principles for a given target type and id. */
  getPrinciples: (
    targetType: string,
    targetId: string
  ) => Promise<DronePrincipleEntry[]>;
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
  onSessionClear: (callback: () => Promise<void>) => void;
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
  /**
   * Dynamically enable and register a plugin mid-session.
   * Returns `true` if the plugin was enabled (or was already enabled),
   * `false` if the plugin ID is unknown. Throws if a hard dependency
   * is not enabled.
   *
   * This is the key mechanism for bootstrap workflows: after writing
   * plugin config to disk, the workflow can immediately enable the
   * plugins so they're available for the kickMessage chat turn.
   */
  enablePlugin: (pluginId: string) => Promise<boolean>;
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
    /**
     * Optional — dispatch a slash command line through the engine's
     * registered slash command handlers. Used by macros to invoke
     * other slash commands.
     */
    dispatchSlashCommand?: (
      line: string,
      ctx: Omit<DroneSlashCommandContext, 'line' | 'args'>
    ) => Promise<boolean>;
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

// ---------------------------------------------------------------------------
// Macros: custom slash commands defined in .macro files
// ---------------------------------------------------------------------------

/**
 * One step in a macro definition.
 * - `slashCommand`: a line starting with `/` that is dispatched as a slash command
 * - `chatPrompt`: any other non-empty, non-comment line sent as a chat message
 */
export type DroneMacroStep =
  | { kind: 'slashCommand'; line: string }
  | { kind: 'chatPrompt'; text: string };

/**
 * A parsed macro definition loaded from a .macro file.
 */
export type DroneMacroDefinition = {
  /** The slash command name, e.g. "/plan" */
  command: string;
  /** Human-readable description (from the #! line or first comment) */
  description: string;
  /** The file path this macro was loaded from */
  filePath: string;
  /** Ordered list of steps to execute */
  steps: DroneMacroStep[];
  /** Whether each positional arg (1..N) is required or optional */
  argSpec: { position: number; required: boolean }[];
  /** Whether $$ (catch-all) is accepted */
  hasCatchAll: boolean;
  /** Whether $$ is optional */
  catchAllOptional: boolean;
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
      '`drone agent` harness initialized. You are primarily a coding agent. Use available tools to answer questions and perform tasks. If a question is ambiguous, ask for clarification. If a question is unanswerable, respond with "I don\'t know."',
    activePersona: null,
    llm: {
      provider: 'ollama',
    },
    ollama: {
      host: 'http://127.0.0.1:11434',
      model: 'llama3.1',
    },
    openrouter: {
      apiKey: '',
      defaultModel: 'openai/gpt-4o',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        { id: 'openai/gpt-4o', contextWindow: 128000 },
        { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000 },
        { id: 'google/gemini-2.0-flash-001', contextWindow: 1000000 },
      ],
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
    },
    log: {
      enabled: true,
    },
    promptFile: {
      enabled: false,
      files: [],
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
    llm: layer.llm
      ? {
          ...baseConfig.llm,
          ...layer.llm,
        }
      : baseConfig.llm,
    ollama: layer.ollama
      ? {
          ...baseConfig.ollama,
          ...layer.ollama,
        }
      : baseConfig.ollama,
    openrouter: layer.openrouter
      ? {
          ...baseConfig.openrouter,
          ...layer.openrouter,
          models: layer.openrouter.models ?? baseConfig.openrouter.models,
        }
      : baseConfig.openrouter,
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
    log: layer.log
      ? {
          ...baseConfig.log,
          ...layer.log,
        }
      : baseConfig.log,
    promptFile: layer.promptFile
      ? {
          ...baseConfig.promptFile,
          ...layer.promptFile,
          files: layer.promptFile.files
            ? [...baseConfig.promptFile.files, ...layer.promptFile.files]
            : baseConfig.promptFile.files,
        }
      : baseConfig.promptFile,
  };
}

export {
  estimateSessionBudget,
  estimateMessageTokens,
  estimateTurnTokens,
  estimateToolDescriptorTokens,
  estimateTextTokens,
} from './token-estimate.js';
/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` (match any sequence of characters) and `?` (match any single char).
 * The pattern is anchored to the full string.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Match a name against a single glob pattern.
 * Supports `*` and `?` wildcards.
 */
export function matchGlob(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

/**
 * Filter a list of items by inclusion/exclusion glob patterns.
 *
 * - If `patterns` is empty or undefined, all items are returned.
 * - Patterns starting with `!` are exclusion patterns (the `!` is stripped).
 * - Items matching at least one inclusion pattern AND not matching any
 *   exclusion pattern are returned.
 * - If no inclusion patterns are given (all patterns are `!`-prefixed),
 *   all items are included by default (only exclusions apply).
 */
export function filterByGlobPatterns(
  items: string[],
  patterns: string[] | undefined
): string[] {
  if (!patterns || patterns.length === 0) {
    return [...items];
  }

  const inclusions: string[] = [];
  const exclusions: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      exclusions.push(pattern.slice(1));
    } else {
      inclusions.push(pattern);
    }
  }

  const hasInclusions = inclusions.length > 0;

  return items.filter(item => {
    // Must match at least one inclusion pattern (or all items if no inclusions)
    if (hasInclusions && !inclusions.some(p => matchGlob(p, item))) {
      return false;
    }
    // Must not match any exclusion pattern
    if (exclusions.some(p => matchGlob(p, item))) {
      return false;
    }
    return true;
  });
}

// ── Config schema (TypeBox) ─────────────────────────────────────────

export {
  PartialDroneAgentConfigSchema,
  parseConfigWithSchema,
  transformEnvVars,
} from './config-schema.js';
export type { PartialDroneAgentConfigDecoded } from './config-schema.js';
