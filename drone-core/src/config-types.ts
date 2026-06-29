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

export type DroneKnowledgeSyncConfig = {
  enabled: boolean;
  pushInsights: boolean;
  pullOnStartup: boolean;
  pullIntervalMinutes: number;
};

export type DroneSwarmConfig = {
  knowledgeSync: DroneKnowledgeSyncConfig;
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
  openrouter: DroneOpenRouterConfig;
  session: DroneSessionConfig;
  lsp: DroneLspConfig;
  mcp: DroneMcpConfig;
  compaction: DroneCompactionConfig;
  memory: DroneMemoryConfig;
  log: DroneLogConfig;
  promptFile: DronePromptFileConfig;
  swarm: DroneSwarmConfig;
};

export type PartialDroneAgentConfig = Partial<{
  enabledPlugins: string[];
  externalPlugins: string[];
  trustedPlugins: Record<string, 'trusted' | 'untrusted'>;
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
  swarm: { knowledgeSync?: Partial<DroneKnowledgeSyncConfig> };
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

// ── Config helper functions ─────────────────────────────────────────

export function createDefaultAgentConfig(): DroneAgentConfig {
  return {
    enabledPlugins: [],
    externalPlugins: [],
    trustedPlugins: {},
    systemPrompt:
      '`drone agent` harness initialized. Use available tools to answer questions and perform tasks exactly as instructed. If a question or request is ambiguous, ask for clarification. If a question is unanswerable, respond with "I don\'t know." If a task is impossible, respond with "I cannot, because..."',
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
    swarm: {
      knowledgeSync: {
        enabled: true,
        pushInsights: true,
        pullOnStartup: true,
        pullIntervalMinutes: 60,
      },
    },
  };
}

export function applyAgentConfigLayer(
  baseConfig: DroneAgentConfig,
  layer: PartialDroneAgentConfig
): DroneAgentConfig {
  return {
    enabledPlugins: layer.enabledPlugins ?? baseConfig.enabledPlugins,
    externalPlugins: layer.externalPlugins ?? baseConfig.externalPlugins,
    trustedPlugins: layer.trustedPlugins
      ? { ...baseConfig.trustedPlugins, ...layer.trustedPlugins }
      : baseConfig.trustedPlugins,
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
          // Merge and deduplicate files from both layers
          files: layer.promptFile.files
            ? [
                ...new Set([
                  ...baseConfig.promptFile.files,
                  ...layer.promptFile.files,
                ]),
              ]
            : baseConfig.promptFile.files,
        }
      : baseConfig.promptFile,
    swarm: layer.swarm
      ? {
          ...baseConfig.swarm,
          ...layer.swarm,
          knowledgeSync: layer.swarm.knowledgeSync
            ? {
                ...baseConfig.swarm.knowledgeSync,
                ...layer.swarm.knowledgeSync,
              }
            : baseConfig.swarm.knowledgeSync,
        }
      : baseConfig.swarm,
  };
}
