/**
 * Shared types for the Ink-based TUI.
 */

import type { DroneColorOverride } from './theme.js';
import type { DronePluginEngine } from '../runtime/plugin-engine.js';

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

/**
 * A single entry in the chat log.
 *
 * `id` is a stable React key. `kind` categorises the entry for
 * color/prefix rendering. `text` is the primary content; multi-line
 * strings render with hard newlines.
 */
export type ChatEntry = {
  /**
   * Stable id used as a React key. Numbers come from a monotonic
   * counter in App; strings are reserved for plugin-injected entries.
   */
  id: number | string;
  /** Categorises the entry for color/prefix. */
  kind:
    | 'info'
    | 'user'
    | 'reasoning'
    | 'toolCall'
    | 'toolResult'
    | 'error'
    | 'plain'
    | 'success'
    | 'markdown';
  /** Primary text. Multi-line strings render with hard newlines. */
  text: string;
};

/**
 * A single item in the tail region — a live-updating component that
 * will later be committed to the <Static> scrollback.
 *
 * `id` is a stable React key. `kind` categorises the item for
 * rendering. `component` is the live React element that re-renders
 * as state changes. `toEntry()` returns the ChatEntry to append
 * to <Static> when this item is committed.
 *
 * Color wrap fix: each tail component wraps its entire content in a
 * single `<Text color={...} wrap="wrap">` element, so Ink applies
 * the color across all soft-wrapped continuation lines.
 */
export type TailItem = {
  id: string;
  kind: 'reasoning' | 'toolCall' | 'assistantMessage';
  component: React.ReactNode;
  toEntry: () => Omit<ChatEntry, 'id'>;
};

/** Options for creating the TUI. */
export type DroneTuiOptions = {
  engine: Pick<
    DronePluginEngine,
    | 'listTools'
    | 'listPlugins'
    | 'getRegisteredPluginCount'
    | 'getRegisteredToolCount'
    | 'getCapability'
    | 'runHooks'
    | 'executeTool'
    | 'getHelpSnippets'
    | 'renderPromptFragments'
    | 'getConfig'
    | 'dispatchSlashCommand'
    | 'setElicitation'
    | 'onConversationEvent'
    | 'runWorkflow'
    | 'getSlashCommands'
  >;
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
    enqueueUserMessage?: (prompt: string) => void;
    cancelCurrentRequest?: () => void;
  };
  model: string;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};
