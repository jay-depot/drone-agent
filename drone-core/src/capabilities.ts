// ── Capability types ───────────────────────────────────────────────

import type { DroneAgentConfig, PartialDroneAgentConfig } from './config-types.js';
import type { DroneSkillDefinition } from './skill-types.js';
import type { DroneSkillProvider, DroneRecallEnhancer, DronePersonaProvider, DroneLlmProvider, DroneLlmProviderRegistration } from './provider-types.js';
import type { DronePersonaDefinition } from './persona-types.js';
import type { DroneToolDescriptor } from './session-types.js';

// ── Config capability ──────────────────────────────────────────────

/**
 * A config injector that provides config values as an underlay.
 * Lower priority = runs first (underlay), higher priority = runs last (overlay).
 * Since beacon config is an underlay, it should have a lower priority than
 * the agent's local config (which wins for conflicts under "most local wins").
 */
export type DroneConfigInjector = {
  /** Unique identifier for this injector (e.g. 'beacon', 'coordinator'). */
  id: string;
  /**
   * Priority value. Lower number = runs first = underlay.
   * Recommended: coordinator=50, beacon=75, agent=100.
   */
  precedence: number;
  /** Inject config values that will be merged as underlay. */
  inject: () => Promise<PartialDroneAgentConfig>;
};

/**
 * Capability offered by the config system. Lets plugins register
 * config injectors that provide defaults (underlay) for the agent config.
 */
export type DroneConfigCapability = {
  /** Register a config injector. */
  registerInjector: (injector: DroneConfigInjector) => void;
  /** Unregister a config injector by id. */
  unregisterInjector: (injectorId: string) => void;
  /** Get all registered injectors sorted by precedence. */
  getInjectors: () => DroneConfigInjector[];
  /**
   * Rebuild the config by calling all injectors and merging results.
   * Returns the merged config.
   */
  rebuild: () => Promise<DroneAgentConfig>;
};

// ── Skills capability ───────────────────────────────────────────────

/**
 * Capability offered by the skills broker plugin. Lets other plugins
 * query skills, manage providers, and register recall enhancers.
 */
export type DroneSkillsCapability = {
  getSkills: () => DroneSkillDefinition[];
  getSkill: (id: string) => DroneSkillDefinition | undefined;
  reloadSkills: () => Promise<void>;
  registerProvider: (provider: DroneSkillProvider) => void;
  unregisterProvider: (providerId: string) => void;
  /** Register a callback that can enhance skill recall results. */
  onRecall: (enhancer: DroneRecallEnhancer) => void;
};

// ── LLM capability ─────────────────────────────────────────────────

/**
 * Capability offered by the LLM broker plugin. Lets other plugins and
 * the host resolve the active LLM provider and manage model selection.
 */
export type DroneLlmCapability = {
  /** Get the active DroneLlmProvider implementation. */
  getActiveProvider: () => DroneLlmProvider;
  /** Get the id of the active provider (e.g. 'ollama', 'openrouter'). */
  getActiveProviderId: () => string;
  /** Get the currently selected model name. */
  getModel: () => string;
  /** Set the currently selected model name. */
  setModel: (model: string) => void;
  /** List available models from the active provider. */
  listModels: () => Promise<string[]>;
  /** Register a provider. Providers are sorted by precedence (ascending). */
  registerProvider: (registration: DroneLlmProviderRegistration) => void;
  /** Unregister a provider by id. */
  unregisterProvider: (providerId: string) => void;
};

// ── Self-improvement types ──────────────────────────────────────────

/**
 * A single principle entry stored in a principles JSON file.
 * Principles are derived from patterns found in insights.
 */
export type DronePrincipleEntry = {
  /** The principle text. */
  principle: string;
  /** Optional description of where this principle came from. */
  source?: string;
  /** ISO-8601 timestamp of when this principle was created. */
  createdAt: string;
};

/**
 * Capability offered by the self-improvement plugin. Lets other plugins
 * (e.g. skills) read principles without coupling to the file system.
 */
export type DronePrinciplesCapability = {
  /** Get all principles for a given target type and id. */
  getPrinciples: (
    targetType: string,
    targetId: string
  ) => Promise<DronePrincipleEntry[]>;
};