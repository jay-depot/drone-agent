import {
  createConsoleLogger,
  getCanonicalToolName,
  type DroneAgentConfig,
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
  type DroneWorkflow,
  type DroneWorkflowContext,
  type DroneWorkflowResult,
  type DroneWorkflowRunReturn,
} from 'drone-core';

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
  runHooks: (hookName: StandardHookName) => Promise<void>;
  runSessionSafetyTrimWillRunHooks: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void>;
  runSessionSafetyTrimAppliedHooks: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void>;
  renderPromptFragments: () => Promise<string[]>;
  getTool: (canonicalName: string) => DroneToolDefinition | undefined;
  executeTool: (
    canonicalName: string,
    input: Record<string, unknown>
  ) => Promise<string>;
  listTools: () => DroneToolDescriptor[];
  getCapability: <T>(pluginId: string) => T | undefined;
  listPlugins: () => DronePluginStatus[];
  getRegisteredPluginCount: () => number;
  getRegisteredToolCount: () => number;
  getHelpSnippets: () => string[];
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
   * and `requestCapability`) and normalizes the workflow's return value
   * into a `DroneWorkflowResult` shape.
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
  /** Returns all slash commands from enabled plugins (for help listings). */
  getSlashCommands: () => DroneSlashCommand[];
};

type CreateDronePluginEngineOptions = {
  plugins: DronePlugin[];
  config: DroneAgentConfig;
  logger?: DroneLogger;
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

  return new Set(
    plugins
      .filter(
        plugin => plugin.metadata.required || plugin.metadata.defaultEnabled
      )
      .map(plugin => plugin.metadata.id)
  );
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
}: CreateDronePluginEngineOptions): DronePluginEngine {
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
  const tools = new Map<string, DroneToolDefinition>();
  const workflows = new Map<string, DroneWorkflow>();
  const promptKeys = new Set<string>();
  const capabilities = new Map<string, unknown>();
  const registeredPlugins: RegisteredPluginState[] = [];
  const helpSnippets = new Map<string, string[]>();
  const slashCommands = new Map<string, DroneSlashCommand[]>();
  const sessionSafetyTrimWillRunHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];
  const sessionSafetyTrimAppliedHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];
  let elicitationCapability: DroneElicitation | undefined;

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
        `Workflow ${canonicalName} requested elicitation, but the host did not provide an interactive capability. Use --plain-output or the TUI; do not run workflows with --once.`
      );
    }
    const ctx: DroneWorkflowContext = {
      elicit,
      projectDir: process.cwd(),
      config,
      requestCapability: <T>(pluginId: string) =>
        capabilities.get(pluginId) as T | undefined,
    };
    const raw = await workflow.run(args, ctx);
    return normalizeWorkflowResult(raw);
  }

  async function registerPlugin(
    plugin: DronePlugin
  ): Promise<RegisteredPluginState> {
    const pluginLogger = createConsoleLogger(plugin.metadata.id);
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
        if (tools.has(canonicalName)) {
          throw new Error(`Tool already registered: ${canonicalName}`);
        }
        tools.set(canonicalName, tool);
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
        if (!dependencyIds.has(pluginId) && !optionalDependencyIds.has(pluginId)) {
          throw new Error(
            `Plugin ${plugin.metadata.id} requested undeclared capability ${pluginId}`
          );
        }
        return capabilities.get(pluginId) as T | undefined;
      },
      runWorkflow: (canonicalName, args) => runWorkflow(canonicalName, args),
      requestElicitation: () => elicitationCapability,
    });

    return {
      plugin,
      tools: pluginTools,
      prompts: pluginPrompts,
    };
  }

  return {
    initialize: async () => {
      logger.info(`initializing ${sortedPlugins.length} plugin(s)`);
      for (const plugin of sortedPlugins) {
        registeredPlugins.push(await registerPlugin(plugin));
      }
      return registeredPlugins;
    },
    runHooks: async hookName => {
      for (const callback of hookBuckets[hookName]) {
        await callback();
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
    renderPromptFragments: async () => {
      const renderedPrompts = await Promise.all(
        promptFragments.map(fragment => fragment.render())
      );
      return renderedPrompts.filter(
        (prompt): prompt is string =>
          typeof prompt === 'string' && prompt.length > 0
      );
    },
    getTool: canonicalName => tools.get(canonicalName),
    executeTool: async (canonicalName, input) => {
      const tool = tools.get(canonicalName);
      if (!tool) {
        throw new Error(`Unknown tool: ${canonicalName}`);
      }
      return tool.execute(input);
    },
    listTools: () =>
      Array.from(tools.entries()).map(([canonicalName, tool]) => ({
        name: canonicalName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
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
    getRegisteredToolCount: () => tools.size,
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
      // Find slash commands from enabled plugins that match the line.
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
            const args = line.slice(cmd.command.length).trim().split(/\s+/).filter(Boolean);
            const handled = await cmd.handler({ ...ctx, line, args });
            if (handled) return true;
          }
        }
      }
      return false;
    },
    getSlashCommands: () => {
      const result: DroneSlashCommand[] = [];
      for (const [pluginId, commands] of slashCommands) {
        if (enabledPluginIds.has(pluginId)) {
          result.push(...commands);
        }
      }
      return result;
    },
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
    (Object.prototype.hasOwnProperty.call(raw, 'kickMessage') ||
      Object.prototype.hasOwnProperty.call(raw, 'toolResult'))
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
