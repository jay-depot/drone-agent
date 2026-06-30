// ── Plugin system types ────────────────────────────────────────────

import type { DroneToolJsonSchema } from './session-types.js';
import type { DroneAgentConfig } from './config-types.js';

// ── Plugin infrastructure ─────────────────────────────────────────

export type DronePlugin = {
  metadata: import('./config-types.js').DronePluginMetadata;
  register: (registration: DronePluginRegistration) => Promise<void>;
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
  onConversationEvent: (
    callback: (
      event: import('./session-types.js').DroneConversationEvent
    ) => Promise<void>
  ) => void;
  onShutdown: (callback: () => Promise<void>) => void;
  onSessionClear: (callback: () => Promise<void>) => void;
  onSessionSafetyTrimWillRun: (
    callback: (
      payload: import('./session-types.js').DroneSessionSafetyTrimPayload
    ) => Promise<void>
  ) => void;
  onSessionSafetyTrimApplied: (
    callback: (
      payload: import('./session-types.js').DroneSessionSafetyTrimPayload
    ) => Promise<void>
  ) => void;
};

/**
 * The set of hook names that `engine.runHooks` accepts — all
 * `DronePluginHooks` keys except the safety-trim hooks (which use
 * their own dedicated engine methods with payloads).
 */
export type DroneStandardHookName = Exclude<
  keyof DronePluginHooks,
  | 'onSessionSafetyTrimWillRun'
  | 'onSessionSafetyTrimApplied'
  | 'onConversationEvent'
>;

export type DronePluginRegistration = {
  logger: import('./session-types.js').DroneLogger;
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

// ── Elicitation types ───────────────────────────────────────────────

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

// ── Workflow types ──────────────────────────────────────────────────

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
  inputSchema?: import('./session-types.js').DroneToolJsonSchema;
  run: (
    input: Record<string, unknown>,
    ctx: DroneWorkflowContext
  ) => Promise<DroneWorkflowRunReturn> | DroneWorkflowRunReturn;
};

// ── Slash command types ────────────────────────────────────────────

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
  logger: import('./session-types.js').DroneLogger;
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
    /** List all plugins (for /plugins). */
    listPlugins?: () => {
      id: string;
      name: string;
      enabled: boolean;
      required: boolean;
      defaultEnabled: boolean;
    }[];
    /** List all tools (for /tools). */
    listTools?: () => import('./session-types.js').DroneToolDescriptor[];
    /** Render prompt fragments (for /systemprompt). */
    renderPromptFragments?: () => Promise<string[]>;
    /** Get the resolved config (for /systemprompt). */
    getConfig?: () => import('./config-types.js').DroneAgentConfig;
    /** Get all slash commands (for /help fallback). */
    getSlashCommands?: () => DroneSlashCommand[];
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
    /** Clear the session (for /clear). */
    clearSession?: () => void;
  };
  /** Session manager for appending synthetic messages. */
  sessionManager?: {
    appendUserMessage: (message: string) => void;
    appendToolResult: (
      toolName: string,
      content: string,
      toolCallId?: string
    ) => void;
  };
  /** Request the host to exit (for /exit, /quit). */
  exit?: () => void;
  /** Host-provided help display function (TUI passes its printHelp, CLI passes its own). */
  printHelp?: () => void;
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

// ── Macro types ─────────────────────────────────────────────────────

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

// Re-export commonly used types from other modules
export type { DroneToolJsonSchema } from './session-types.js';
