/**
 * Public API for user/project-level plugins.
 *
 * Import from `drone-agent/lib` (or `@drone-ai/drone-agent/lib` once published).
 */

// ---------------------------------------------------------------------------
// Plugin engine
// ---------------------------------------------------------------------------
export { createDronePluginEngine } from './runtime/plugin-engine.js';
export type {
  DronePluginEngine,
  DronePluginStatus,
  RegisteredPluginState,
} from './runtime/plugin-engine.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export { loadAgentConfig } from './runtime/config.js';

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------
export { createSessionManager } from './runtime/session-manager.js';
export type { DroneSessionManager } from './runtime/session-manager.js';

// ---------------------------------------------------------------------------
// Conversation service
// ---------------------------------------------------------------------------
export {
  createConversationService,
  CANCEL_SENTINEL,
} from './runtime/conversation-service.js';
export type { ConversationService } from './runtime/conversation-service.js';

// ---------------------------------------------------------------------------
// External plugin loader
// ---------------------------------------------------------------------------
export {
  discoverExternalPlugins,
  loadPluginFromDirectory,
  loadTrustedPlugins,
  saveTrustedPlugin,
  promptForPluginTrust,
} from './plugins/external-loader.js';
export type { DiscoveredExternalPlugins } from './plugins/external-loader.js';

// ---------------------------------------------------------------------------
// Built-in plugins
// ---------------------------------------------------------------------------
export {
  builtInPlugins,
  createBuiltInPlugins,
  createCompactionPlugin,
} from './plugins/index.js';
export type {
  CompactionPluginDeps,
  CompactionCapability,
} from './plugins/index.js';
