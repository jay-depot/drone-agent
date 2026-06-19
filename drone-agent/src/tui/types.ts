/**
 * Shared types for the Ink-based TUI.
 */

import type { DroneColorOverride } from './theme.js';

/**
 * Capability offered by the TUI for plugins to extend.
 *
 * `pushColorOverride` / `popColorOverride` manage a stack of tints
 * applied over the base grayscale theme. The TUI cycles through the
 * stack on a timer. A plugin is responsible for popping its override
 * when it is "done" — pushed overrides are not auto-cleaned up.
 *
 * The previous blessed-based capability also exposed
 * `registerPanel` / `registerStatusItem` / `registerKeybinding` /
 * `setStatusText`. Those were unused by any plugin; the port drops
 * the surface rather than re-implementing it. Add back later if
 * concrete plugins need it.
 */
export type DroneTuiCapability = {
  pushColorOverride: (override: DroneColorOverride) => void;
  popColorOverride: (overrideId: string) => void;
};

/** Options for creating the TUI. */
export type DroneTuiOptions = {
  engine: {
    listTools: () => { name: string; description: string }[];
    listPlugins: () => { id: string; name: string; enabled: boolean }[];
    getRegisteredPluginCount: () => number;
    getRegisteredToolCount: () => number;
    getCapability: <T>(pluginId: string) => T | undefined;
    runHooks: (
      hookName: import('../runtime/plugin-engine.js').StandardHookName
    ) => Promise<void>;
    executeTool: (
      name: string,
      input: Record<string, unknown>
    ) => Promise<string>;
    getHelpSnippets: () => string[];
  };
  conversation: {
    sendUserMessage: (
      prompt: string,
      onEvent?: (
        event: import('../runtime/conversation-service.js').ConversationEvent
      ) => void
    ) => Promise<string>;
    clearSession: () => void;
    getEstimatedContextUsagePercent: () => Promise<number>;
    setModel: (newModel: string) => void;
    getModel: () => string;
  };
  model: string;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};
