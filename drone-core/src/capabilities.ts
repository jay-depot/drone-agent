// ── Capability types ───────────────────────────────────────────────

import type { DroneReasoningLevel } from './config-types.js';
import type {
  DroneAgentConfig,
  PartialDroneAgentConfig,
} from './config-types.js';
import type { DroneSkillDefinition } from './skill-types.js';
import type {
  DroneSkillProvider,
  DroneRecallEnhancer,
  DroneSkillWriter,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
} from './provider-types.js';

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
  /** Register a skill writer. Writers are sorted by precedence (ascending). */
  registerWriter: (writer: DroneSkillWriter) => void;
  /** Unregister a skill writer by id. */
  unregisterWriter: (writerId: string) => void;
  /** Get all registered skill writers, sorted by precedence. */
  getWriters: () => DroneSkillWriter[];
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
  /** List all registered provider ids in precedence order. */
  getAvailableProviders: () => Array<{ id: string; precedence: number }>;
  /** Activate a provider by id and switch to its default model. */
  activateProvider: (providerId: string) => void;
  /** Get the currently selected model name. */
  getModel: () => string;
  /** Set the currently selected model name. */
  setModel: (model: string) => void;
  /** Get the current reasoning level, or undefined for provider default. */
  getReasoningLevel: () => DroneReasoningLevel | undefined;
  /** Set the reasoning level for the current session. */
  setReasoningLevel: (level: DroneReasoningLevel | undefined) => void;
  /** List available models from the active provider. */
  listModels: () => Promise<string[]>;
  /** Check whether a specific model supports vision. */
  hasVision?: (model: string) => boolean | Promise<boolean>;
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

// ── Insight/Principle storage engine types ────────────────────────────

/**
 * A single insight entry stored in an insights file or table.
 */
export type DroneInsightEntry = {
  /** ISO-8601 timestamp of when this insight was recorded. */
  timestamp: string;
  /** The insight text (1-3 sentence observation). */
  insight: string;
  /** ISO-8601 timestamp of the last time this insight was examined (e.g. by the promotion process). Undefined = never examined. */
  lastExamined?: string;
};

/**
 * Storage engine for insights, registered by identity asset providers.
 * File-based providers (project/user) read/write local JSON files.
 * HTTP providers (swarm) proxy to beacon/coordinator endpoints.
 */
export type DroneInsightStorageEngine = {
  /** Provider ID that owns this storage engine (e.g. 'persona-provider-project'). */
  providerId: string;
  /** Record an insight for a target. */
  recordInsight: (
    targetType: string,
    targetId: string,
    insight: string
  ) => Promise<{ ok: boolean; entryCount: number }>;
  /** List all insight files/entries for a target type, optionally filtered by targetId. */
  listInsights: (
    targetType: string,
    targetId?: string
  ) => Promise<
    Array<{
      targetType: string;
      targetId: string;
      entryCount: number;
      lastTimestamp?: string;
    }>
  >;
  /** Read all insights for a specific target. */
  readInsights: (
    targetType: string,
    targetId: string
  ) => Promise<DroneInsightEntry[]>;
  /** Mark all insights for a target as examined "as of now". */
  markInsightsExamined: (
    targetType: string,
    targetId: string
  ) => Promise<{ ok: boolean; markedCount: number }>;
};

/**
 * Storage engine for principles, registered by identity asset providers.
 */
export type DronePrincipleStorageEngine = {
  /** Provider ID that owns this storage engine. */
  providerId: string;
  /** Store a principle for a target. */
  storePrinciple: (
    targetType: string,
    targetId: string,
    principle: string,
    source?: string
  ) => Promise<{ ok: boolean; principleCount: number }>;
  /** List all principle files/entries for a target type, optionally filtered by targetId. */
  listPrinciples: (
    targetType: string,
    targetId?: string
  ) => Promise<
    Array<{ targetType: string; targetId: string; principleCount: number }>
  >;
  /** Read all principles for a specific target. */
  readPrinciples: (
    targetType: string,
    targetId: string
  ) => Promise<DronePrincipleEntry[]>;
  /** Delete a principle by index for a target. */
  deletePrinciple: (
    targetType: string,
    targetId: string,
    index: number
  ) => Promise<{ ok: boolean; remainingCount: number }>;
};

/**
 * Capability offered by the self-improvement broker plugin.
 * Lets other plugins register storage engines and query principles.
 */
export type DroneSelfImprovementCapability = {
  /** Register a storage engine for insights. */
  registerInsightEngine: (engine: DroneInsightStorageEngine) => void;
  /** Unregister a storage engine by provider ID. */
  unregisterInsightEngine: (providerId: string) => void;
  /** Register a storage engine for principles. */
  registerPrincipleEngine: (engine: DronePrincipleStorageEngine) => void;
  /** Unregister a principle storage engine by provider ID. */
  unregisterPrincipleEngine: (providerId: string) => void;
  /** Get all principles for a given target type and id (aggregated from all engines). */
  getPrinciples: (
    targetType: string,
    targetId: string
  ) => Promise<DronePrincipleEntry[]>;
};
