import {
  createConsoleLogger,
  createDebugFlagRegistry,
  createRuntimeFlagRegistry,
  type DebugFlagRegistry,
  type DroneChatMessage,
  getCanonicalToolName,
  type RuntimeFlagRegistry,
  type DroneAgentConfig,
  type DroneConversationEvent,
  type DroneElicitation,
  type DroneLogger,
  type DronePlugin,
  type DronePromptFragment,
  type DroneSessionSafetyTrimPayload,
  type DroneSlashCommand,
  type DroneSlashCommandContext,
  type DroneStandardHookName,
  type DroneToolDescriptor,
  type DroneToolDefinition,
  type DroneToolExecutionContext,
  type DroneWorkflow,
  type DroneWorkflowContext,
  type DroneWorkflowResult,
  type DroneWorkflowRunReturn,
  ToolRegistry,
} from 'drone-core';

import { BUILT_IN_SLASH_COMMANDS } from './builtin-commands.js';
import { SystemReminderQueue } from './system-reminders.js';

export type RegisteredPluginState = {
  plugin: DronePlugin;
  tools: DroneToolDefinition[];
  prompts: DronePromptFragment[];
};

export type DronePluginStatus = {
  id: string;
  name: string;
  enabled: boolean;
  required: boolean;
  defaultEnabled: boolean;
};

export type StandardHookName = DroneStandardHookName;

type HookBuckets = Record<StandardHookName, Array<() => Promise<void>>>;

export type DronePluginEngine = {
  initialize: () => Promise<RegisteredPluginState[]>;
  /**
   * Dynamically enable and register a plugin mid-session.
   *
   * If the plugin is already enabled, returns `true` (idempotent).
   * If the plugin ID is unknown (not in the plugin registry), returns `false`.
   * Validates that all non-optional dependencies are enabled; throws if not.
   * After registration, runs the plugin's `onPluginsLoaded` and
   * `onSessionStart` hooks so it catches up with the session lifecycle.
   */
  enablePlugin: (pluginId: string) => Promise<boolean>;
  /**
   * Add an external plugin to the engine after construction.
   *
   * The plugin is added to the internal registry, registered (tools, hooks,
   * capabilities, etc.), and catch-up lifecycle hooks (onPluginsLoaded,
   * onSessionStart) are run so it catches up with the session lifecycle.
   *
   * Returns `false` if a plugin with the same ID is already registered
   * (built-in or previously added). Returns `true` on success.
   */
  addExternalPlugin: (plugin: DronePlugin) => Promise<boolean>;
  runHooks: (hookName: StandardHookName) => Promise<void>;
  runSessionSafetyTrimWillRunHooks: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void>;
  runSessionSafetyTrimAppliedHooks: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void>;
  runConversationEventHooks: (event: DroneConversationEvent) => Promise<void>;
  /**
   * Register a listener for conversation events (reasoning, toolCall,
   * toolResult, assistantMessage, error). Returns an unsubscribe function.
   * Events are also forwarded to plugin hooks registered via
   * `registration.hooks.onConversationEvent`.
   */
  onConversationEvent: (
    callback: (event: DroneConversationEvent) => void
  ) => () => void;
  renderPromptFragments: () => Promise<string[]>;
  getTool: (canonicalName: string) => DroneToolDefinition | undefined;
  executeTool: (
    canonicalName: string,
    input: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    context?: DroneToolExecutionContext
  ) => Promise<string>;
  listTools: () => DroneToolDescriptor[];
  listAllTools: () => DroneToolDescriptor[];
  /** Mount a tool by canonical name (e.g. "file__read"). Returns the tool definition if newly mounted, else undefined. */
  mountTool: (canonicalName: string) => DroneToolDefinition | undefined;
  /** Unmount a mounted tool by canonical name. */
  unmountTool: (canonicalName: string) => void;
  /** List currently-mounted tools. */
  listMountedTools: () => DroneToolDescriptor[];
  getCapability: <T>(pluginId: string) => T | undefined;
  listPlugins: () => DronePluginStatus[];
  getRegisteredPluginCount: () => number;
  getRegisteredToolCount: () => number;
  getMountedToolCount: () => number;
  getHelpSnippets: () => string[];
  /**
   * Remove all tools registered by a plugin. Used when re-mounting tools
   * after a reconnection (e.g. MCP server respawn) or when handling
   * notifications/tools/list_changed. Clears the plugin's tool list so
   * subsequent registerTool calls for the same names won't hit the
   * duplicate check.
   */
  unregisterPluginTools: (pluginId: string) => void;
  /**
   * Remove a single tool by its canonical name. Used for unmounting
   * individual dynamically-mounted tools (e.g. MCP tools mounted via
   * `__mount_tool`). Silently does nothing if the tool is not found.
   */
  unregisterTool: (canonicalName: string) => void;
  /** Returns the resolved DroneAgentConfig used by the engine. */
  getConfig: () => DroneAgentConfig;
  /** Returns the runtime flag registry, for injecting into the system prompt. */
  getRuntimeFlags: () => RuntimeFlagRegistry;
  /** Build the full system messages as sent to the LLM (config prompt + runtime flags + prompt fragments). */
  buildSystemMessages: () => Promise<DroneChatMessage[]>;
  /**
   * Drain queued one-shot system reminders for inclusion in the next LLM
   * call as non-persisted system messages. The conversation service calls
   * this when assembling outgoing messages.
   */
  drainSystemReminders: () => string[];
  /**
   * Clear any queued system reminders without delivering them. Called on
   * session clear so stale reminders never leak into a fresh session.
   */
  clearSystemReminders: () => void;
  /**
   * Set the host's elicitation capability. Must be called by the CLI shell
   * or TUI App BEFORE any workflow runs (and before `onSessionStart` if
   * plugins want to elicit during session bootstrap).
   */
  setElicitation: (capability: DroneElicitation | undefined) => void;
  /** Returns the host's elicitation capability, or undefined in non-interactive modes. */
  getElicitation: () => DroneElicitation | undefined;
  /**
   * Run a registered workflow by canonical name (`<plugin>.<workflow>`).
   * Builds the workflow context (with `elicit`, `projectDir`, `config`,
   * `requestCapability`, and `enablePlugin`) and normalizes the workflow's
   * return value into a `DroneWorkflowResult` shape.
   */
  runWorkflow: (
    canonicalName: string,
    args: Record<string, unknown>
  ) => Promise<DroneWorkflowResult>;
  /**
   * Dispatch a user-entered line to the first matching registered slash
   * command from an enabled plugin. Returns `true` if a handler claimed
   * the line, `false` if no registered command matched. The host should
   * check this before its own hardcoded dispatch chain.
   */
  dispatchSlashCommand: (
    line: string,
    ctx: Omit<DroneSlashCommandContext, 'line' | 'args'>
  ) => Promise<boolean>;
  /** Returns all slash commands (plugin + built-in) for help listings. */
  getSlashCommands: () => DroneSlashCommand[];
  /**
   * Register a built-in slash command (lower precedence than plugin commands).
   * Built-in commands are checked after plugin commands during dispatch.
   */
  registerBuiltinSlashCommand: (command: DroneSlashCommand) => void;
  /** Returns all built-in slash commands. */
  getBuiltinSlashCommands: () => DroneSlashCommand[];
};

type CreateDronePluginEngineOptions = {
  plugins: DronePlugin[];
  config: DroneAgentConfig;
  logger?: DroneLogger;
  logToStderr?: boolean;
  debugFlags?: DebugFlagRegistry;
  runtimeOptions?: {
    subagentId?: string;
    persona?: string;
  };
  buildSystemMessages?: () => Promise<DroneChatMessage[]>;
  /**
   * Optional callback to reset the conversation's stuck-detector state
   * (identical-tool-call streak, broken-response counter). Exposed to
   * plugins via the `_runtime` capability so e.g. a subagent return or a
   * user-visible recovery path can clear guardrail detectors.
   */
  resetStuckDetectors?: () => void;
};

function createHookBuckets(): HookBuckets {
  return {
    onPluginsLoaded: [],
    onSessionStart: [],
    onBeforePrompt: [],
    onAfterToolCall: [],
    onSessionClear: [],
    onShutdown: [],
  };
}

export function getDefaultEnabledPluginIds(plugins: DronePlugin[]): string[] {
  return plugins
    .filter(
      plugin => plugin.metadata.required || plugin.metadata.defaultEnabled
    )
    .map(plugin => plugin.metadata.id);
}

function resolveEnabledPluginIds(
  plugins: DronePlugin[],
  config: DroneAgentConfig
): Set<string> {
  if (config.enabledPlugins.length > 0) {
    const enabledPluginIds = new Set(config.enabledPlugins);
    for (const plugin of plugins) {
      if (plugin.metadata.required) {
        enabledPluginIds.add(plugin.metadata.id);
      }
    }
    return enabledPluginIds;
  }

  return new Set(getDefaultEnabledPluginIds(plugins));
}

function validatePluginRegistry(
  plugins: DronePlugin[]
): Map<string, DronePlugin> {
  const pluginMap = new Map<string, DronePlugin>();

  for (const plugin of plugins) {
    if (pluginMap.has(plugin.metadata.id)) {
      throw new Error(`Duplicate plugin id detected: ${plugin.metadata.id}`);
    }
    pluginMap.set(plugin.metadata.id, plugin);
  }

  return pluginMap;
}

function validateKnownEnabledPlugins(
  enabledPluginIds: Set<string>,
  pluginMap: Map<string, DronePlugin>
): void {
  for (const pluginId of enabledPluginIds) {
    if (!pluginMap.has(pluginId)) {
      throw new Error(`Config enabled unknown plugin: ${pluginId}`);
    }
  }
}

function sortPluginsByDependencies(
  plugins: DronePlugin[],
  enabledPluginIds: Set<string>,
  pluginMap: Map<string, DronePlugin>
): DronePlugin[] {
  const sorted: DronePlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(plugin: DronePlugin): void {
    const pluginId = plugin.metadata.id;
    if (!enabledPluginIds.has(pluginId) || visited.has(pluginId)) {
      return;
    }
    if (visiting.has(pluginId)) {
      throw new Error(`Plugin dependency cycle detected at ${pluginId}`);
    }

    visiting.add(pluginId);
    for (const dependency of plugin.metadata.dependencies ?? []) {
      const dependencyPlugin = pluginMap.get(dependency.id);
      if (!dependencyPlugin || !enabledPluginIds.has(dependency.id)) {
        if (dependency.optional) {
          continue;
        }
        throw new Error(
          `Plugin ${pluginId} requires missing or disabled dependency ${dependency.id}`
        );
      }
      visit(dependencyPlugin);
    }
    visiting.delete(pluginId);
    visited.add(pluginId);
    sorted.push(plugin);
  }

  for (const plugin of plugins) {
    visit(plugin);
  }

  return sorted;
}

export function createDronePluginEngine({
  plugins,
  config,
  logger = createConsoleLogger('plugin-engine'),
  logToStderr = false,
  debugFlags = createDebugFlagRegistry(),
  runtimeOptions,
  buildSystemMessages: buildSystemMessagesFromHost,
  resetStuckDetectors: resetStuckDetectorsFromHost,
}: CreateDronePluginEngineOptions): DronePluginEngine {
  const systemReminders = new SystemReminderQueue();
  const pluginMap = validatePluginRegistry(plugins);
  const enabledPluginIds = resolveEnabledPluginIds(plugins, config);
  validateKnownEnabledPlugins(enabledPluginIds, pluginMap);
  const sortedPlugins = sortPluginsByDependencies(
    plugins,
    enabledPluginIds,
    pluginMap
  );

  const hookBuckets = createHookBuckets();
  const promptFragments: DronePromptFragment[] = [];
  const toolRegistry = new ToolRegistry();
  const workflows = new Map<string, DroneWorkflow>();
  const promptKeys = new Set<string>();
  const capabilities = new Map<string, unknown>();
  const registeredPlugins: RegisteredPluginState[] = [];
  const runtimeFlagRegistry = createRuntimeFlagRegistry();
  const helpSnippets = new Map<string, string[]>();
  const slashCommands = new Map<string, DroneSlashCommand[]>();
  const builtInSlashCommands: DroneSlashCommand[] = [];
  const sessionSafetyTrimWillRunHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];
  const sessionSafetyTrimAppliedHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];
  const conversationEventHooks: Array<
    (event: DroneConversationEvent) => Promise<void>
  > = [];
  const externalConversationEventListeners: Array<
    (event: DroneConversationEvent) => void
  > = [];
  let elicitationCapability: DroneElicitation | undefined;
  const logToolChange = (kind: string, detail: string): void => {
    if (debugFlags.isEnabled('tools')) {
      console.error(`[tools:${kind}] ${detail}`);
    }
  };

  // --- Local functions (declared before the return object so they can ---)
  // --- reference each other and be used in the return object)       ---

  async function doEnablePlugin(pluginId: string): Promise<boolean> {
    // Unknown plugin — nothing to enable.
    const plugin = pluginMap.get(pluginId);
    if (!plugin) {
      return false;
    }
    // Already enabled — idempotent.
    if (enabledPluginIds.has(pluginId)) {
      return true;
    }
    // Validate non-optional dependencies are enabled.
    for (const dep of plugin.metadata.dependencies ?? []) {
      if (!dep.optional && !enabledPluginIds.has(dep.id)) {
        throw new Error(
          `Cannot enable plugin ${pluginId}: requires dependency ${dep.id} which is not enabled`
        );
      }
    }
    // Add to enabled set and register.
    enabledPluginIds.add(pluginId);
    registeredPlugins.push(await registerPlugin(plugin));
    logToolChange('enable-plugin', pluginId);
    logger.info(`enabled plugin: ${pluginId}`);
    // Run lifecycle hooks so the plugin catches up.
    for (const callback of hookBuckets.onPluginsLoaded) {
      await callback();
    }
    for (const callback of hookBuckets.onSessionStart) {
      await callback();
    }
    return true;
  }

  async function doAddExternalPlugin(plugin: DronePlugin): Promise<boolean> {
    const pluginId = plugin.metadata.id;
    // Check if already registered (built-in or previously added).
    if (pluginMap.has(pluginId)) {
      return false;
    }
    // Add to registry and enable.
    pluginMap.set(pluginId, plugin);
    enabledPluginIds.add(pluginId);
    // Register it.
    registeredPlugins.push(await registerPlugin(plugin));
    logToolChange('add-external-plugin', pluginId);
    logger.info(`added external plugin: ${pluginId}`);
    // Run catch-up lifecycle hooks.
    for (const callback of hookBuckets.onPluginsLoaded) {
      await callback();
    }
    for (const callback of hookBuckets.onSessionStart) {
      await callback();
    }
    return true;
  }

  async function runWorkflow(
    canonicalName: string,
    args: Record<string, unknown>
  ): Promise<DroneWorkflowResult> {
    const workflow = workflows.get(canonicalName);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${canonicalName}`);
    }
    const elicit = elicitationCapability;
    if (!elicit) {
      throw new Error(
        `Workflow ${canonicalName} requested elicitation, but the host did not provide an interactive capability. Use --output-plain or the TUI; do not run workflows with --once.`
      );
    }
    const ctx: DroneWorkflowContext = {
      elicit,
      projectDir: process.cwd(),
      config,
      requestCapability: <T>(pluginId: string) =>
        capabilities.get(pluginId) as T | undefined,
      enablePlugin: (pluginId: string) => doEnablePlugin(pluginId),
    };
    const raw = await workflow.run(args, ctx);
    return normalizeWorkflowResult(raw);
  }

  function unregisterPluginToolsImpl(pluginId: string): void {
    // Delete all tools whose canonical name starts with the plugin prefix.
    const prefix = `${pluginId}__`;
    toolRegistry.removeByPrefix(prefix);
    logToolChange('unregister-plugin', pluginId);
    // Also clear the plugin's own tool list so it doesn't hold stale refs.
    const registered = registeredPlugins.find(
      (p: { plugin: { metadata: { id: string } } }) =>
        p.plugin.metadata.id === pluginId
    );
    if (registered) {
      registered.tools = [];
    }
  }

  function unregisterToolImpl(canonicalName: string): void {
    if (!toolRegistry.get(canonicalName)) {
      return;
    }
    toolRegistry.remove(canonicalName);
    logToolChange('unregister', canonicalName);
    for (const registered of registeredPlugins) {
      const idx = registered.tools.findIndex(
        (t: DroneToolDefinition) =>
          getCanonicalToolName(registered.plugin.metadata.id, t.name) ===
          canonicalName
      );
      if (idx >= 0) {
        registered.tools.splice(idx, 1);
        break;
      }
    }
  }

  async function registerPlugin(
    plugin: DronePlugin
  ): Promise<RegisteredPluginState> {
    const pluginLogger = createConsoleLogger(plugin.metadata.id, {
      toStderr: logToStderr,
    });
    const pluginTools: DroneToolDefinition[] = [];
    const pluginPrompts: DronePromptFragment[] = [];
    const dependencyIds = new Set<string>();
    const optionalDependencyIds = new Set<string>();
    for (const dep of plugin.metadata.dependencies ?? []) {
      if (dep.optional) {
        optionalDependencyIds.add(dep.id);
      } else {
        dependencyIds.add(dep.id);
      }
    }

    await plugin.register({
      logger: pluginLogger,
      getConfig: () => config,
      registerTool: tool => {
        const canonicalName = getCanonicalToolName(
          plugin.metadata.id,
          tool.name
        );
        if (toolRegistry.get(canonicalName)) {
          throw new Error(`Tool already registered: ${canonicalName}`);
        }
        toolRegistry.add(canonicalName, tool);
        logToolChange('register', canonicalName);
        pluginTools.push(tool);
      },
      registerPromptFragment: fragment => {
        const promptKey = `${plugin.metadata.id}.${fragment.key}`;
        if (promptKeys.has(promptKey)) {
          throw new Error(`Prompt fragment already registered: ${promptKey}`);
        }
        promptKeys.add(promptKey);
        promptFragments.push(fragment);
        pluginPrompts.push(fragment);
      },
      registerHelp: (help: string) => {
        const existing = helpSnippets.get(plugin.metadata.id) ?? [];
        existing.push(help);
        helpSnippets.set(plugin.metadata.id, existing);
      },
      registerWorkflow: workflow => {
        const canonicalName = getCanonicalToolName(
          plugin.metadata.id,
          workflow.name
        );
        if (workflows.has(canonicalName)) {
          throw new Error(`Workflow already registered: ${canonicalName}`);
        }
        workflows.set(canonicalName, workflow);
      },
      registerSlashCommand: command => {
        const existing = slashCommands.get(plugin.metadata.id) ?? [];
        // Check for duplicates within the same plugin.
        if (existing.some(cmd => cmd.command === command.command)) {
          throw new Error(
            `Slash command already registered: ${command.command}`
          );
        }
        existing.push(command);
        slashCommands.set(plugin.metadata.id, existing);
      },
      hooks: {
        onPluginsLoaded: callback => hookBuckets.onPluginsLoaded.push(callback),
        onSessionStart: callback => hookBuckets.onSessionStart.push(callback),
        onBeforePrompt: callback => hookBuckets.onBeforePrompt.push(callback),
        onAfterToolCall: callback => hookBuckets.onAfterToolCall.push(callback),
        onConversationEvent: callback => conversationEventHooks.push(callback),
        onSessionClear: callback => hookBuckets.onSessionClear.push(callback),
        onShutdown: callback => hookBuckets.onShutdown.push(callback),
        onSessionSafetyTrimWillRun: callback =>
          sessionSafetyTrimWillRunHooks.push(callback),
        onSessionSafetyTrimApplied: callback =>
          sessionSafetyTrimAppliedHooks.push(callback),
      },
      offer: capability => {
        capabilities.set(plugin.metadata.id, capability);
      },
      request: <T>(pluginId: string) => {
        // Special case: allow requesting 'runtime' without declaration
        if (pluginId === 'runtime') {
          return capabilities.get('_runtime') as T | undefined;
        }
        if (
          !dependencyIds.has(pluginId) &&
          !optionalDependencyIds.has(pluginId)
        ) {
          throw new Error(
            `Plugin ${plugin.metadata.id} requested undeclared capability ${pluginId}`
          );
        }
        return capabilities.get(pluginId) as T | undefined;
      },
      runWorkflow: (canonicalName, args) => runWorkflow(canonicalName, args),
      requestElicitation: () => elicitationCapability,
      mountTool: (canonicalName: string) => {
        const def = toolRegistry.mount(canonicalName);
        if (def) {
          logToolChange('mount', canonicalName);
        }
        return def;
      },
      unmountTool: (canonicalName: string) => {
        toolRegistry.unmount(canonicalName);
        logToolChange('unmount', canonicalName);
      },
      listMountedTools: () => {
        return toolRegistry.listMounted();
      },
      unregisterPluginTools: (pluginId: string) => {
        unregisterPluginToolsImpl(pluginId);
      },
      unregisterTool: (canonicalName: string) => {
        unregisterToolImpl(canonicalName);
      },
    });

    return {
      plugin,
      tools: pluginTools,
      prompts: pluginPrompts,
    };
  }

  /**
   * Detect built-in commands that have been overridden by plugin commands
   * and log a warning for each.
   */
  function logOverrideWarnings(): void {
    const pluginCommandSet = new Set<string>();
    for (const [, commands] of slashCommands) {
      for (const cmd of commands) {
        pluginCommandSet.add(cmd.command);
      }
    }
    for (const builtIn of builtInSlashCommands) {
      if (pluginCommandSet.has(builtIn.command)) {
        // Find which plugin overrode it.
        for (const [pluginId, commands] of slashCommands) {
          if (commands.some(cmd => cmd.command === builtIn.command)) {
            logger.warn(
              `⚠ Built-in command ${builtIn.command} overridden by plugin "${pluginId}"`
            );
            break;
          }
        }
      }
    }
  }

  /**
   * Register the three runtime meta-tools that are always available:
   * runtime__list_tools, runtime__mount_tool, runtime__unmount_tool.
   */
  function registerRuntimeMetaTools(): void {
    const metaTools: Array<{
      name: string;
      description: string;
      inputSchema: import('drone-core').DroneToolJsonSchema;
      execute: (input: Record<string, unknown>) => Promise<string>;
    }> = [
      {
        name: 'runtime__list_tools',
        description:
          'List all available tools. Optionally filter by plugin (e.g. "file"). Pass includeSchemas=true to include input schemas.',
        inputSchema: {
          type: 'object',
          properties: {
            plugin: {
              type: 'string',
              description:
                'Optional plugin ID to filter by (e.g. "file", "git", "mcp").',
            },
            includeSchemas: {
              type: 'boolean',
              description: 'If true, include input schemas in the response.',
            },
          },
          additionalProperties: false,
        },
        execute: async input => {
          const pluginFilter =
            typeof input.plugin === 'string' ? input.plugin : undefined;
          const includeSchemas = input.includeSchemas === true;

          // Always build full descriptors (with real defaultHidden) for filtering.
          let descriptors = toolRegistry.listUnmountedWithSchemas(pluginFilter);

          // Filter by persona visibility (default-hidden + allowedTools overlay).
          const personaCap = capabilities.get('persona') as
            | {
                getFilteredTools: (
                  tools: import('drone-core').DroneToolDescriptor[]
                ) => import('drone-core').DroneToolDescriptor[];
              }
            | undefined;
          if (personaCap) {
            descriptors = personaCap.getFilteredTools(descriptors);
          } else {
            // No persona plugin: honor default visibility by hiding defaultHidden tools.
            descriptors = descriptors.filter(t => !t.defaultHidden);
          }

          // Build the response, stripping schemas unless requested.
          const tools = includeSchemas
            ? descriptors
            : descriptors.map(({ name, description }) => ({
                name,
                description,
              }));

          return JSON.stringify({ toolCount: tools.length, tools }, null, 2);
        },
      },
      {
        name: 'runtime__mount_tool',
        description:
          'Mount a tool by canonical name (e.g. "file__read"). Once mounted, the tool appears in your tool list with its full schema.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Canonical tool name to mount (e.g. "file__read").',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        execute: async input => {
          const toolName =
            typeof input.tool === 'string' ? input.tool.trim() : '';
          if (!toolName) {
            throw new Error(
              'runtime__mount_tool requires a non-empty tool name.'
            );
          }

          const result = toolRegistry.mount(toolName);
          if (!result) {
            return JSON.stringify(
              {
                success: false,
                error: `Unknown or already mounted tool: ${toolName}. Use runtime__list_tools to see available tools.`,
              },
              null,
              2
            );
          }
          logToolChange('mount', toolName);
          return JSON.stringify(
            {
              success: true,
              tool: toolName,
              description: result.description,
            },
            null,
            2
          );
        },
      },
      {
        name: 'runtime__unmount_tool',
        description:
          'Unmount a previously mounted tool by canonical name. Reduces clutter.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Canonical tool name to unmount.',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        execute: async input => {
          const toolName =
            typeof input.tool === 'string' ? input.tool.trim() : '';
          if (!toolName) {
            throw new Error(
              'runtime__unmount_tool requires a non-empty tool name.'
            );
          }

          toolRegistry.unmount(toolName);
          logToolChange('unmount', toolName);
          return JSON.stringify({ success: true, tool: toolName }, null, 2);
        },
      },
    ];

    for (const tool of metaTools) {
      toolRegistry.add(tool.name, tool);
      logToolChange('register', tool.name);
      toolRegistry.mount(tool.name);
      logToolChange('mount', tool.name);
    }
  }

  return {
    initialize: async () => {
      // Register built-in slash commands before plugins load.
      for (const cmd of BUILT_IN_SLASH_COMMANDS) {
        builtInSlashCommands.push(cmd);
      }

      // Set _runtime BEFORE plugin registration so plugins can request it during register()
      capabilities.set('_runtime', {
        subagentId: runtimeOptions?.subagentId,
        persona: runtimeOptions?.persona,
        isSubagent: !!runtimeOptions?.subagentId,
        debugFlags,
        flags: runtimeFlagRegistry,
        resetStuckDetectors: resetStuckDetectorsFromHost,
        queueSystemReminder: (content: string) =>
          systemReminders.queue(content),
      });

      logger.info(`initializing ${sortedPlugins.length} plugin(s)`);
      for (const plugin of sortedPlugins) {
        registeredPlugins.push(await registerPlugin(plugin));
      }

      // Register runtime meta-tools (always available)
      registerRuntimeMetaTools();

      // Inject enabled plugin list into system prompt
      const enabledPluginList = Array.from(enabledPluginIds).sort().join(', ');
      runtimeFlagRegistry.set('plugins', enabledPluginList);

      // Log override warnings after all plugins are loaded.
      logOverrideWarnings();

      return registeredPlugins;
    },
    enablePlugin: doEnablePlugin,
    addExternalPlugin: doAddExternalPlugin,
    runHooks: async hookName => {
      for (const callback of hookBuckets[hookName]) {
        try {
          await callback();
        } catch (hookError) {
          // A failure in onBeforePrompt must not abort the conversation
          // turn or terminate the loop — log it and keep going so the
          // user's message is still processed. Mirrors the non-fatal
          // onAfterToolCall handling in the conversation service.
          if (hookName === 'onBeforePrompt') {
            const msg =
              hookError instanceof Error
                ? hookError.message
                : String(hookError);
            logger.warn(`onBeforePrompt hook error (non-fatal): ${msg}`);
            continue;
          }
          throw hookError;
        }
      }
    },
    runSessionSafetyTrimWillRunHooks: async payload => {
      for (const callback of sessionSafetyTrimWillRunHooks) {
        await callback(payload);
      }
    },
    runSessionSafetyTrimAppliedHooks: async payload => {
      for (const callback of sessionSafetyTrimAppliedHooks) {
        await callback(payload);
      }
    },
    runConversationEventHooks: async (event: DroneConversationEvent) => {
      for (const callback of conversationEventHooks) {
        await callback(event);
      }
      // Also notify external listeners
      for (const callback of externalConversationEventListeners) {
        callback(event);
      }
    },
    onConversationEvent: callback => {
      externalConversationEventListeners.push(callback);
      return () => {
        const idx = externalConversationEventListeners.indexOf(callback);
        if (idx !== -1) externalConversationEventListeners.splice(idx, 1);
      };
    },
    renderPromptFragments: async () => {
      const renderedPrompts = await Promise.all(
        promptFragments.map(fragment => fragment.render())
      );
      return renderedPrompts.filter(
        (prompt): prompt is string =>
          typeof prompt === 'string' && prompt.length > 0
      );
    },
    getTool: canonicalName => toolRegistry.get(canonicalName),
    executeTool: async (canonicalName, input, onProgress, context) => {
      const tool = toolRegistry.get(canonicalName);
      if (!tool) {
        throw new Error(`Unknown tool: ${canonicalName}`);
      }
      return tool.execute(input, onProgress, context);
    },
    listTools: () => toolRegistry.listMounted(),
    listAllTools: () => toolRegistry.listAll(),
    mountTool: canonicalName => toolRegistry.mount(canonicalName),
    unmountTool: canonicalName => toolRegistry.unmount(canonicalName),
    listMountedTools: () => toolRegistry.listMounted(),
    getCapability: <T>(pluginId: string) =>
      capabilities.get(pluginId) as T | undefined,
    listPlugins: () =>
      plugins.map(plugin => ({
        id: plugin.metadata.id,
        name: plugin.metadata.name,
        enabled: enabledPluginIds.has(plugin.metadata.id),
        required: Boolean(plugin.metadata.required),
        defaultEnabled: Boolean(plugin.metadata.defaultEnabled),
      })),
    getRegisteredPluginCount: () => registeredPlugins.length,
    getRegisteredToolCount: () => toolRegistry.getTotalCount(),
    getMountedToolCount: () => toolRegistry.getMountedCount(),
    getConfig: () => config,
    getRuntimeFlags: () => runtimeFlagRegistry,
    buildSystemMessages: async () => {
      if (buildSystemMessagesFromHost) {
        return buildSystemMessagesFromHost();
      }
      // Fallback: assemble manually (same as the old /systemprompt behavior).
      // Use promptFragments directly (not renderPromptFragments, which is a
      // method on the return object and not yet accessible here).
      const base: DroneChatMessage[] = [
        { role: 'system', content: config.systemPrompt },
      ];
      const fragments = (
        await Promise.all(promptFragments.map(f => f.render()))
      ).filter((p): p is string => typeof p === 'string' && p.length > 0);
      for (const content of fragments) {
        base.push({ role: 'system', content });
      }
      return base;
    },
    unregisterPluginTools: (pluginId: string) => {
      unregisterPluginToolsImpl(pluginId);
    },
    drainSystemReminders: () => systemReminders.drainAll(),
    clearSystemReminders: () => systemReminders.clear(),
    unregisterTool: (canonicalName: string) => {
      unregisterToolImpl(canonicalName);
    },
    getHelpSnippets: () => {
      const result: string[] = [];
      for (const [pluginId, snippets] of helpSnippets) {
        if (enabledPluginIds.has(pluginId)) {
          result.push(...snippets);
        }
      }
      return result;
    },
    setElicitation: capability => {
      elicitationCapability = capability;
    },
    getElicitation: () => elicitationCapability,
    runWorkflow,
    dispatchSlashCommand: async (line, ctx) => {
      // First: check plugin slash commands (higher precedence).
      for (const [pluginId, commands] of slashCommands) {
        if (!enabledPluginIds.has(pluginId)) continue;
        for (const cmd of commands) {
          // Match if the line is exactly the command, or starts with
          // the command followed by a space/tab (subcommand or args).
          if (
            line === cmd.command ||
            line.startsWith(cmd.command + ' ') ||
            line.startsWith(cmd.command + '\t')
          ) {
            const args = line
              .slice(cmd.command.length)
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            const handled = await cmd.handler({ ...ctx, line, args });
            if (handled) return true;
          }
        }
      }

      // Second: check built-in slash commands (lower precedence).
      for (const cmd of builtInSlashCommands) {
        if (
          line === cmd.command ||
          line.startsWith(cmd.command + ' ') ||
          line.startsWith(cmd.command + '\t')
        ) {
          const args = line
            .slice(cmd.command.length)
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const handled = await cmd.handler({ ...ctx, line, args });
          if (handled) return true;
        }
      }

      return false;
    },
    getSlashCommands: () => {
      const result: DroneSlashCommand[] = [];
      // Plugin commands first.
      for (const [pluginId, commands] of slashCommands) {
        if (enabledPluginIds.has(pluginId)) {
          result.push(...commands);
        }
      }
      // Then built-in commands.
      result.push(...builtInSlashCommands);
      return result;
    },
    registerBuiltinSlashCommand: (command: DroneSlashCommand) => {
      // Check for duplicates.
      if (builtInSlashCommands.some(cmd => cmd.command === command.command)) {
        throw new Error(
          `Built-in slash command already registered: ${command.command}`
        );
      }
      builtInSlashCommands.push(command);
    },
    getBuiltinSlashCommands: () => [...builtInSlashCommands],
  };
}

function normalizeWorkflowResult(
  raw: DroneWorkflowRunReturn | undefined | null
): DroneWorkflowResult {
  if (raw === undefined || raw === null) {
    return { toolResult: '{}' };
  }
  if (typeof raw === 'string') {
    return { toolResult: raw };
  }
  // Treat any object with at least one of `kickMessage`/`toolResult` as a
  // result shape (don't JSON.stringify it). Anything else gets serialized.
  if (
    typeof raw === 'object' &&
    ('kickMessage' in raw || 'toolResult' in raw)
  ) {
    const result: DroneWorkflowResult = {};
    if (typeof raw.kickMessage === 'string') {
      result.kickMessage = raw.kickMessage;
    }
    if (typeof raw.toolResult === 'string') {
      result.toolResult = raw.toolResult;
    }
    return result;
  }
  return { toolResult: JSON.stringify(raw) };
}
