import {
  createConsoleLogger,
  type DroneSessionSafetyTrimPayload,
  getCanonicalToolName,
  type DroneAgentConfig,
  type DroneLogger,
  type DronePlugin,
  type DronePluginHooks,
  type DronePromptFragment,
  type DroneToolDescriptor,
  type DroneToolDefinition,
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

type StandardHookName = Exclude<
  keyof DronePluginHooks,
  'onSessionSafetyTrimWillRun' | 'onSessionSafetyTrimApplied'
>;

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
  const promptKeys = new Set<string>();
  const capabilities = new Map<string, unknown>();
  const registeredPlugins: RegisteredPluginState[] = [];
  const sessionSafetyTrimWillRunHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];
  const sessionSafetyTrimAppliedHooks: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  > = [];

  async function registerPlugin(
    plugin: DronePlugin
  ): Promise<RegisteredPluginState> {
    const pluginLogger = createConsoleLogger(plugin.metadata.id);
    const pluginTools: DroneToolDefinition[] = [];
    const pluginPrompts: DronePromptFragment[] = [];
    const dependencyIds = new Set(
      (plugin.metadata.dependencies ?? []).map(dependency => dependency.id)
    );

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
      hooks: {
        onPluginsLoaded: callback => hookBuckets.onPluginsLoaded.push(callback),
        onSessionStart: callback => hookBuckets.onSessionStart.push(callback),
        onBeforePrompt: callback => hookBuckets.onBeforePrompt.push(callback),
        onAfterToolCall: callback => hookBuckets.onAfterToolCall.push(callback),
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
        if (!dependencyIds.has(pluginId)) {
          throw new Error(
            `Plugin ${plugin.metadata.id} requested undeclared capability ${pluginId}`
          );
        }
        return capabilities.get(pluginId) as T | undefined;
      },
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
  };
}
