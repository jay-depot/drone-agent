/**
 * Shared types for the Ink-based TUI.
 */

import type { DroneColorOverride } from './theme.js';

/**
 * A mid-panel widget registered by a plugin.
 *
 * `id` must be unique across all widgets. `label` is a short header string
 * shown before the widget's content (e.g. "TODO"). `getContent()` returns
 * the lines to render; return an empty array to hide the widget. Each line
 * is rendered inline in a horizontal bar.
 */
export type MidPanelWidget = {
  id: string;
  label: string;
  getContent: () => string[];
};

/**
 * Capability offered by the TUI for plugins to extend.
 *
 * `pushColorOverride` / `popColorOverride` manage a stack of tints
 * applied over the base grayscale theme. The TUI cycles through the
 * stack on a timer. A plugin is responsible for popping its override
 * when it is "done" — pushed overrides are not auto-cleaned up.
 *
 * `registerMidPanelWidget` lets plugins register content that
 * appears in the mid-panel bar between the chat log and input line.
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
  /** Register a mid-panel widget. Called by plugins that offer mid-panel content. */
  registerMidPanelWidget: (widget: MidPanelWidget) => void;
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
    /**
     * Dispatch a user-entered line to registered plugin slash commands.
     * Returns true if a handler claimed the line.
     */
    dispatchSlashCommand?: (
      line: string,
      ctx: Omit<
        import('drone-core').DroneSlashCommandContext,
        'line' | 'args'
      >
    ) => Promise<boolean>;
    /**
     * Optional. Set the host's elicitation capability; called by App
     * on mount to register its TUI-flavoured implementation.
     */
    setElicitation?: (
      cap: import('drone-core').DroneElicitation | undefined
    ) => void;
    /**
     * Optional. Run a registered workflow by canonical name.
     */
    runWorkflow?: (
      canonicalName: string,
      args: Record<string, unknown>
    ) => Promise<import('drone-core').DroneWorkflowResult>;
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
