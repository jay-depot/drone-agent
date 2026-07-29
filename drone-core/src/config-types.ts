// ── Search config types ─────────────────────────────────────────────

export type DroneSearchPath = {
  path: string;
  embeddingProvider?: string;
  includeHidden?: boolean;
  includeNodeModules?: boolean;
  exclude?: string[];
};

export type DroneSearchConfig = {
  enabled: boolean;
  paths: DroneSearchPath[];
  userEmbeddingProvider?: string;
  projectEmbeddingProvider?: string;
};
import { deepMerge, type MergeSpec } from './deep-merge.js';

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

// ── Config types ────────────────────────────────────────────────────

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

export type DroneReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export type DroneOllamaConfig = {
  host: string;
  model: string;
  reasoningLevel?: DroneReasoningLevel;
  hasVision?: boolean;
};

export type DroneLlmConfig = {
  /** The id of the active LLM provider plugin (e.g. 'ollama', 'openrouter'). */
  provider: string;
  reasoningLevel?: DroneReasoningLevel;
};

export type DroneOpenRouterModelConfig = {
  id: string;
  contextWindow: number;
  hasVision?: boolean;
};

export type DroneOpenRouterConfig = {
  apiKey: string;
  defaultModel: string;
  reasoningLevel?: DroneReasoningLevel;
  baseUrl: string;
  models: DroneOpenRouterModelConfig[];
};

export type DroneOpenAiModelConfig = {
  id: string;
  contextWindow: number;
};

export type DroneOpenAiConfig = {
  apiKey: string;
  defaultModel: string;
  baseUrl: string;
  orgId?: string;
  models: DroneOpenAiModelConfig[];
};

export type DroneAnthropicModelConfig = {
  id: string;
  contextWindow: number;
};

export type DroneAnthropicConfig = {
  apiKey: string;
  defaultModel: string;
  baseUrl: string;
  apiVersion: string;
  models: DroneAnthropicModelConfig[];
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
  /**
   * Maximum size in bytes for images read via file__read_image or returned
   * from MCP tools. Images exceeding this size will be rejected.
   * Default is 20MB (20 * 1024 * 1024).
   */
  maxImageSizeBytes?: number;
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

export type DroneTerminalConfig = {
  enabled: boolean;
  maxActiveSessions: number;
  defaultShell: string;
  defaultCols: number;
  defaultRows: number;
};

export type DronePromptFileConfig = {
  enabled: boolean;
  files: string[];
};

export type DroneKnowledgeSyncConfig = {
  enabled?: boolean;
  pushInsights?: boolean;
  pullOnStartup?: boolean;
  pullIntervalMinutes?: number;
};

export type DroneSwarmConfig = {
  knowledgeSync?: DroneKnowledgeSyncConfig;
  /** Hostname of the drone-beacon instance for swarm operations. */
  beaconHost?: string;
  /** Port of the drone-beacon instance for swarm operations. */
  beaconPort?: number;
  /** Whether to use HTTPS when connecting to the beacon. */
  beaconUseHttps?: boolean;
  /** URL of the drone-coordinator instance for remote spawn and info tools. */
  coordinatorUrl?: string;
  /** Optional session ID override for this agent. */
  sessionId?: string;
};

export type DroneTuiConfig = {
  syntaxHighlighting: {
    colors: Record<string, string>;
    codeBackground: string;
  };
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
  /** Timeout in ms for the initialize handshake after spawning. */
  spawnTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseSizeBytes?: number;
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
  /** Timeout in ms for the initialize handshake after spawning. */
  spawnTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseSizeBytes?: number;
  retryCount?: number;
  retryDelayMs?: number;
  maxListPages?: number;
  maxListItems?: number;
  compatibilityMode?: 'strict' | 'permissive';
};

export type DroneMcpServerConfig =
  | DroneMcpStdioServerConfig
  | DroneMcpStreamableHttpServerConfig;

export type DroneMcpRoot = {
  uri: string;
  name?: string;
};

export type DroneMcpConfig = {
  enabled: boolean;
  requestTimeoutMs: number;
  spawnTimeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  maxListPages: number;
  maxListItems: number;
  compatibilityMode: 'strict' | 'permissive';
  maxResponseSizeBytes: number;
  servers: Record<string, DroneMcpServerConfig>;
  roots?: DroneMcpRoot[];
};

export type DroneAgentConfig = {
  enabledPlugins: string[];
  /** Plugin IDs loaded from external directories (for tracking). */
  externalPlugins: string[];
  /**
   * User-scoped trust map: absolute plugin directory path → 'trusted' | 'untrusted'.
   * Project-level plugins are checked against this before loading.
   */
  trustedPlugins: Record<string, 'trusted' | 'untrusted'>;
  systemPrompt: string;
  activePersona: string | null;
  llm: DroneLlmConfig;
  ollama: DroneOllamaConfig;
  openai: DroneOpenAiConfig;
  anthropic: DroneAnthropicConfig;
  openrouter: DroneOpenRouterConfig;
  session: DroneSessionConfig;
  lsp: DroneLspConfig;
  mcp: DroneMcpConfig;
  compaction: DroneCompactionConfig;
  memory: DroneMemoryConfig;
  log: DroneLogConfig;
  terminal: DroneTerminalConfig;
  promptFile: DronePromptFileConfig;
  swarm: DroneSwarmConfig;
  search: DroneSearchConfig;
  tui: DroneTuiConfig;
};

export type PartialDroneAgentConfig = Partial<{
  enabledPlugins: string[];
  externalPlugins: string[];
  trustedPlugins: Record<string, 'trusted' | 'untrusted'>;
  systemPrompt: string;
  activePersona: string | null;
  llm: Partial<DroneLlmConfig>;
  ollama: Partial<DroneOllamaConfig>;
  openai: Partial<DroneOpenAiConfig>;
  anthropic: Partial<DroneAnthropicConfig>;
  openrouter: Partial<DroneOpenRouterConfig>;
  session: Partial<DroneSessionConfig>;
  lsp: Partial<DroneLspConfig>;
  mcp: Partial<DroneMcpConfig>;
  compaction: Partial<DroneCompactionConfig>;
  memory: Partial<DroneMemoryConfig>;
  log: Partial<DroneLogConfig>;
  promptFile: Partial<DronePromptFileConfig>;
  terminal: Partial<DroneTerminalConfig>;
  swarm: Partial<DroneSwarmConfig>;
  search: Partial<DroneSearchConfig>;
  tui?: Partial<DroneTuiConfig>;
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

// ── Config helper functions ─────────────────────────────────────────

const CONFIG_MERGE_SPEC: MergeSpec = {
  replace: ['enabledPlugins', 'externalPlugins', 'systemPrompt'],
  replaceNullable: ['activePersona'],
  merge: [
    'trustedPlugins',
    'llm',
    'ollama',
    'session',
    'compaction',
    'memory',
    'log',
    'terminal',
    'search',
  ],
  deepMerge: {
    openai: { replace: ['models'] },
    anthropic: { replace: ['models'] },
    openrouter: { replace: ['models'] },
    lsp: { replace: ['servers'] },
    mcp: { replace: ['servers'] },
    promptFile: { mergeArrays: ['files'] },
    swarm: { deepMerge: { knowledgeSync: {} } },
    tui: {
      deepMerge: {
        syntaxHighlighting: { deepMerge: { colors: {} } },
      },
    },
  },
};

export function createDefaultAgentConfig(
  overrides?: Partial<DroneAgentConfig>
): DroneAgentConfig {
  const base: DroneAgentConfig = {
    enabledPlugins: [],
    externalPlugins: [],
    trustedPlugins: {},
    systemPrompt:
      '`drone agent` harness initialized. Use available tools to answer ' +
      'questions and perform tasks. Always proceed exactly as instructed. If a ' +
      'question or request is ambiguous, ask for clarification. If a question is ' +
      'unanswerable, respond with "I don\'t know." If a task is impossible, respond ' +
      'with "I cannot, because..."',
    activePersona: null,
    llm: {
      provider: 'ollama',
    },
    ollama: {
      host: 'http://127.0.0.1:11434',
      model: 'llama3.1',
    },
    openai: {
      apiKey: '',
      defaultModel: 'gpt-5.3-codex',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-5.4-pro', contextWindow: 1000000 },
        { id: 'gpt-5.3-codex', contextWindow: 400000 },
        { id: 'gpt-5.4-mini', contextWindow: 400000 },
      ],
    },
    anthropic: {
      apiKey: '',
      defaultModel: 'claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
      apiVersion: '2023-06-01',
      models: [
        { id: 'claude-haiku-4-5', contextWindow: 200000 },
        { id: 'claude-sonnet-4-6', contextWindow: 1000000 },
        { id: 'claude-opus-4-8', contextWindow: 1000000 },
      ],
    },
    openrouter: {
      apiKey: '',
      defaultModel: 'openai/gpt-5.3-codex',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        { id: 'openai/gpt-5.3-codex', contextWindow: 400000 },
        { id: 'anthropic/claude-opus-4.8', contextWindow: 1000000 },
        { id: 'google/gemini-2.0-flash-001', contextWindow: 1000000 },
      ],
    },
    session: {
      contextWindowTokens: 32768,
      responseReserveTokens: 4096,
      maxToolIterations: 50,
      maxImageSizeBytes: 20 * 1024 * 1024,
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
      spawnTimeoutMs: 30000,
      retryCount: 1,
      retryDelayMs: 200,
      maxListPages: 25,
      maxListItems: 500,
      compatibilityMode: 'strict',
      maxResponseSizeBytes: 1048576,
      servers: {},
    },
    compaction: {
      enabled: true,
      strategy: 'summary-drop',
      softThresholdPercent: 50,
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
    terminal: {
      enabled: false,
      maxActiveSessions: 5,
      defaultShell: '',
      defaultCols: 80,
      defaultRows: 24,
    },
    promptFile: {
      enabled: false,
      files: [],
    },
    swarm: {
      knowledgeSync: {
        enabled: true,
        pushInsights: true,
        pullOnStartup: true,
        pullIntervalMinutes: 60,
      },
    },
    search: {
      enabled: false,
      paths: [],
    },
    tui: {
      syntaxHighlighting: {
        colors: {
          keyword: 'magenta',
          function: 'cyan',
          'function-variable': 'cyan',
          string: 'green',
          number: 'yellow',
          comment: 'gray',
          emphasis: 'italic',
          strong: 'bold',
          variable: 'blue',
          attr: 'yellow',
          tag: 'magenta',
          built_in: 'cyan',
          literal: 'yellow',
          selector: 'yellow',
          'selector-class': 'yellow',
          'selector-id': 'yellow',
          property: 'blue',
          title: 'cyan',
          params: 'white',
          sub: 'gray',
          sup: 'gray',
        },
        codeBackground: 'gray',
      },
    },
  };
  return { ...base, ...overrides };
}

export function applyAgentConfigLayer(
  baseConfig: DroneAgentConfig,
  layer: PartialDroneAgentConfig
): DroneAgentConfig {
  return deepMerge(baseConfig, layer, CONFIG_MERGE_SPEC) as DroneAgentConfig;
}
