import { SystemReminderQueue } from '../src/runtime/system-reminders.js';
import { vi } from 'vitest';
import {
  createConsoleLogger,
  createRuntimeFlagRegistry,
  type DroneConversationEvent,
  type DroneElicitation,
  type DroneLogger,
  type DronePlugin,
  type DronePluginMetadata,
  type DronePluginRegistration,
  type DronePromptFragment,
  type DroneSessionSafetyTrimPayload,
  type DroneToolDescriptor,
  type DroneToolDefinition,
  type DroneWorkflow,
} from 'drone-core';

/**
 * Returns a logger that swallows output, for noisy test runs.
 */
export function silentLogger(): DroneLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Use the real console logger, useful for debugging failing tests locally.
 */
export function consoleLogger(scope = 'test'): DroneLogger {
  return createConsoleLogger(scope);
}

type Register = (registration: DronePluginRegistration) => Promise<void> | void;

export type TestPluginHookOptions = {
  onPluginsLoaded?: () => Promise<void> | void;
  onSessionStart?: () => Promise<void> | void;
  onBeforePrompt?: () => Promise<void> | void;
  onAfterToolCall?: () => Promise<void> | void;
  onConversationEvent?: (event: DroneConversationEvent) => Promise<void> | void;
  onSessionClear?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
  onSessionSafetyTrimWillRun?: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void> | void;
  onSessionSafetyTrimApplied?: (
    payload: DroneSessionSafetyTrimPayload
  ) => Promise<void> | void;
};

export type TestPluginOptions = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  required?: boolean;
  defaultEnabled?: boolean;
  dependencies?: { id: string; version?: string; optional?: boolean }[];
  register?: Register;
  tools?: DroneToolDefinition[];
  prompts?: DronePromptFragment[];
  help?: string[];
  workflows?: DroneWorkflow[];
  hooks?: TestPluginHookOptions;
  capability?: unknown;
  requestSpy?: (pluginId: string) => unknown;
};

export function createTestPlugin(options: TestPluginOptions): DronePlugin {
  const metadata: DronePluginMetadata = {
    id: options.id,
    name: options.name ?? options.id,
    version: options.version ?? '0.0.0',
    description: options.description ?? '',
    required: options.required,
    // Default test plugins to enabled so the engine auto-picks them up.
    // Individual tests can opt out by passing `defaultEnabled: false`.
    defaultEnabled:
      options.defaultEnabled === undefined ? true : options.defaultEnabled,
    dependencies: options.dependencies,
  };

  return {
    metadata,
    register: async (registration: DronePluginRegistration) => {
      for (const tool of options.tools ?? []) {
        registration.registerTool(tool);
      }
      for (const prompt of options.prompts ?? []) {
        registration.registerPromptFragment(prompt);
      }
      for (const help of options.help ?? []) {
        registration.registerHelp(help);
      }
      for (const workflow of options.workflows ?? []) {
        registration.registerWorkflow(workflow);
      }
      if (options.capability !== undefined) {
        registration.offer(options.capability);
      }

      const hooks = options.hooks;
      if (hooks?.onPluginsLoaded) {
        const cb = hooks.onPluginsLoaded;
        registration.hooks.onPluginsLoaded(async () => {
          await cb();
        });
      }
      if (hooks?.onSessionStart) {
        const cb = hooks.onSessionStart;
        registration.hooks.onSessionStart(async () => {
          await cb();
        });
      }
      if (hooks?.onBeforePrompt) {
        const cb = hooks.onBeforePrompt;
        registration.hooks.onBeforePrompt(async () => {
          await cb();
        });
      }
      if (hooks?.onAfterToolCall) {
        const cb = hooks.onAfterToolCall;
        registration.hooks.onAfterToolCall(async () => {
          await cb();
        });
      }
      if (hooks?.onConversationEvent) {
        const cb = hooks.onConversationEvent;
        registration.hooks.onConversationEvent(async event => {
          await cb(event);
        });
      }
      if (hooks?.onSessionClear) {
        const cb = hooks.onSessionClear;
        registration.hooks.onSessionClear(async () => {
          await cb();
        });
      }
      if (hooks?.onShutdown) {
        const cb = hooks.onShutdown;
        registration.hooks.onShutdown(async () => {
          await cb();
        });
      }
      if (hooks?.onSessionSafetyTrimWillRun) {
        const cb = hooks.onSessionSafetyTrimWillRun;
        registration.hooks.onSessionSafetyTrimWillRun(async payload => {
          await cb(payload);
        });
      }
      if (hooks?.onSessionSafetyTrimApplied) {
        const cb = hooks.onSessionSafetyTrimApplied;
        registration.hooks.onSessionSafetyTrimApplied(async payload => {
          await cb(payload);
        });
      }

      if (options.register) {
        await options.register(registration);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fake engine for unit tests that don't need the full engine.
// ---------------------------------------------------------------------------

export type FakeEngineOptions = {
  promptFragments?: string[];
  elicit?: DroneElicitation;
};

/**
 * Build a fake `DronePluginEngine` good enough for unit-testing plugins
 * that don't touch the tool registry. Includes the new workflow +
 * elicitation surfaces added when we introduced `DroneWorkflow`.
 */
export function createFakeEngine(
  options: FakeEngineOptions = {}
): import('../src/runtime/plugin-engine.js').DronePluginEngine & {
  __elicitation?: DroneElicitation;
} {
  let elicit: DroneElicitation | undefined = options.elicit;
  return {
    initialize: async () => [],
    enablePlugin: async (_pluginId: string) => false,
    buildSystemMessages: async () => [],
    addExternalPlugin: async (_plugin: DronePlugin) => false,
    runHooks: async () => {},
    runSessionSafetyTrimWillRunHooks: async () => {},
    runSessionSafetyTrimAppliedHooks: async () => {},
    runConversationEventHooks: async () => {},
    renderPromptFragments: async () => options.promptFragments ?? [],
    getTool: () => undefined,
    executeTool: async () => '',
    listTools: () => [],
    listAllTools: () => [],
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    getMountedToolCount: () => 0,
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    getCapability: <T>() => undefined as T | undefined,
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => 0,
    getHelpSnippets: () => [],
    drainSystemReminders: () => [],
    clearSystemReminders: () => {},
    getConfig: () => {
      throw new Error('getConfig not implemented in fake engine');
    },
    getRuntimeFlags: () => createRuntimeFlagRegistry(),
    setElicitation: cap => {
      elicit = cap;
    },
    getElicitation: () => elicit,
    runWorkflow: async () => {
      throw new Error('runWorkflow not implemented in fake engine');
    },
    dispatchSlashCommand: async () => false,
    getSlashCommands: () => [],
    onConversationEvent: () => () => {},
    registerBuiltinSlashCommand: () => {},
    getBuiltinSlashCommands: () => [],
    __elicitation: options.elicit,
  };
}

// ---------------------------------------------------------------------------
// Mock engine for conversation-service tests
// ---------------------------------------------------------------------------

export type MockEngineOptions = {
  tools: DroneToolDescriptor[];
  executeToolImpl: (
    name: string,
    input: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    context?: import('drone-core').DroneToolExecutionContext
  ) => Promise<string>;
  promptFragments?: string[];
  /** Optional custom getCapability override. Defaults to returning {} for 'llm'. */
  getCapability?: <T>(id: string) => T | undefined;
};

/**
 * Build a mock `DronePluginEngine` for conversation-service tests.
 * Returns the engine plus the underlying `vi.fn()` execute mock.
 *
 * The default `getCapability` returns `{}` for `'llm'` and `undefined` for
 * everything else. Pass a custom `getCapability` to override (e.g. to also
 * return a persona capability).
 */
export function createMockEngine(
  options: MockEngineOptions
): import('../src/runtime/plugin-engine.js').DronePluginEngine & {
  __executeMock: ReturnType<typeof vi.fn>;
  __reminderQueue: SystemReminderQueue;
} {
  const executeMock = vi.fn(options.executeToolImpl);
  const toolList = options.tools;
  const customGetCapability = options.getCapability;
  const reminderQueue = new SystemReminderQueue();

  return {
    initialize: async () => [],
    runHooks: async () => {},
    runSessionSafetyTrimWillRunHooks: async () => {},
    runSessionSafetyTrimAppliedHooks: async () => {},
    runConversationEventHooks: async () => {},
    renderPromptFragments: async () => options.promptFragments ?? [],
    getTool: () => undefined,
    executeTool:
      executeMock as unknown as import('../src/runtime/plugin-engine.js').DronePluginEngine['executeTool'],
    listTools: () => toolList,
    getCapability:
      customGetCapability ??
      (<T>(id: string) => (id === 'llm' ? ({} as unknown as T) : undefined)),
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => toolList.length,
    getMountedToolCount: () => 0,
    listAllTools: () => toolList,
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    getHelpSnippets: () => [],
    getConfig: () => {
      throw new Error('getConfig not used in conversation-service tests');
    },
    getRuntimeFlags: () => createRuntimeFlagRegistry(),
    setElicitation: () => {},
    getElicitation: () => undefined,
    runWorkflow: async () => {
      throw new Error('runWorkflow not used in conversation-service tests');
    },
    dispatchSlashCommand: async () => false,
    getSlashCommands: () => [],
    drainSystemReminders: () => reminderQueue.drainAll(),
    clearSystemReminders: () => reminderQueue.clear(),
    onConversationEvent: () => () => {},
    registerBuiltinSlashCommand: () => {},
    getBuiltinSlashCommands: () => [],
    enablePlugin: async (_pluginId: string) => false,
    buildSystemMessages: async () => [],
    addExternalPlugin: async (_plugin: any) => false,
    __executeMock: executeMock,
    __reminderQueue: reminderQueue,
  };
}
