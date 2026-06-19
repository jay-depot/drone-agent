/**
 * Shared types for the blessed-based TUI.
 */

import type { StandardHookName } from '../runtime/plugin-engine.js';
import type { DroneColorOverride } from './theme.js';

/** A panel that can be registered by a plugin to extend the TUI. */
export type DroneTuiPanel = {
  id: string;
  label: string;
  render: () => string;
};

/** A status bar item contributed by a plugin. */
export type DroneTuiStatusItem = {
  id: string;
  text: string;
};

/** Keybinding contributed by a plugin. */
export type DroneTuiKeybinding = {
  keys: string[];
  description: string;
  handler: () => void | Promise<void>;
};

/**
 * Capability offered by the TUI for plugins to extend.
 *
 * `pushColorOverride` / `popColorOverride` manage a stack of tints
 * applied over the base grayscale theme. The TUI cycles through the
 * stack on a timer. A plugin is responsible for popping its override
 * when it is "done" — pushed overrides are not auto-cleaned up.
 */
export type DroneTuiCapability = {
  registerPanel: (panel: DroneTuiPanel) => void;
  registerStatusItem: (item: DroneTuiStatusItem) => void;
  registerKeybinding: (binding: DroneTuiKeybinding) => void;
  setStatusText: (text: string) => void;
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
    runHooks: (hookName: StandardHookName) => Promise<void>;
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
