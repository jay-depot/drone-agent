// ── Provider types for skill/persona/llm broker architecture ───────

import type { DroneReasoningLevel } from './config-types.js';

/**
 * A writer for personas, registered by persona provider plugins.
 * The persona broker aggregates these and exposes them via its capability.
 */
export type DronePersonaWriter = {
  /** Unique id for this writer (e.g. 'persona-provider-project'). */
  id: string;
  /** The scope this writer targets (project, user, beacon, coordinator). */
  scope: 'project' | 'user' | 'beacon' | 'coordinator';
  /** Human-readable label for UI choices (e.g. 'Project (./.drone-agent/personas/)'). */
  label: string;
  /** Check if a persona with this id already exists at the target location. */
  exists: (id: string) => Promise<boolean>;
  /** Write a persona .md file to the target location. Returns the file path. */
  writePersona: (id: string, content: string) => Promise<{ filePath: string }>;
};

/**
 * A writer for skills, registered by skill provider plugins.
 * The skills broker aggregates these and exposes them via its capability.
 */
export type DroneSkillWriter = {
  /** Unique id for this writer (e.g. 'skill-provider-project'). */
  id: string;
  /** The scope this writer targets (project, user, beacon, coordinator). */
  scope: 'project' | 'user' | 'beacon' | 'coordinator';
  /** Human-readable label for UI choices (e.g. 'Project (./.drone-agent/skills/)'). */
  label: string;
  /** Check if a skill with this id already exists at the target location. */
  exists: (id: string) => Promise<boolean>;
  /** Write a skill .md file to the target location. Returns the file path. */
  writeSkill: (id: string, content: string) => Promise<{ filePath: string }>;
};

import type { DroneSkillDefinition } from './skill-types.js';
import type { DronePersonaDefinition } from './persona-types.js';
import type {
  DroneChatMessage,
  DroneToolDescriptor,
  DroneContextWindowInfo,
  DroneChatResponse,
} from './session-types.js';

/**
 * A provider of skills registered with the skills broker plugin.
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DroneSkillProvider = {
  /** Unique id for this provider (e.g. 'skill-provider-project'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  precedence: number;
  /** Get all skills from this provider. */
  getSkills: () => DroneSkillDefinition[];
  /** Get a single skill by id, or undefined. */
  getSkill: (id: string) => DroneSkillDefinition | undefined;
  /** Reload skills from source (disk, network, etc.). */
  reloadSkills: () => Promise<void>;
};

/**
 * Callback invoked after a skill is recalled. Receives the skill id and
 * the current body text. Returns a modified body (or the original).
 */
export type DroneRecallEnhancer = (id: string, body: string) => Promise<string>;

/**
 * A provider of personas registered with the persona broker plugin.
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DronePersonaProvider = {
  /** Unique id for this provider (e.g. 'persona-provider-project'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  precedence: number;
  /** Get all personas from this provider. */
  getPersonas: () => DronePersonaDefinition[];
  /** Get a single persona by id, or undefined. */
  getPersona: (id: string) => DronePersonaDefinition | undefined;
  /** Reload personas from source (disk, network, etc.). */
  reloadPersonas: () => Promise<void>;
};

/**
 * Input to DroneLlmProvider.chat(). The leading fields are the stable wire
 * contract; the trailing optional fields are broker-enriched additions
 * (parameters/extra passthrough, resolved metadata) that drivers may
 * consume but existing providers can ignore.
 */
export type DroneChatRequest = {
  model: string;
  messages: DroneChatMessage[];
  tools?: DroneToolDescriptor[];
  reasoningLevel?: DroneReasoningLevel;
  debug?: boolean;
  /** Effective sampling parameters (provider ⊕ model shallow merge). */
  parameters?: Record<string, unknown>;
  /** Silent raw passthrough bag merged into native request payloads. */
  extra?: Record<string, unknown>;
  /** Resolved max output tokens for this model. */
  maxOutputTokens?: number;
  /** Resolved vision capability for this model. */
  hasVision?: boolean;
};

export type DroneLlmProvider = {
  chat: (input: DroneChatRequest) => Promise<DroneChatResponse>;
  getContextWindowInfo?: (input: {
    model: string;
  }) => Promise<DroneContextWindowInfo | null>;
  supportsImagesInToolResults?: boolean;
};

// ── LLM provider broker types ───────────────────────────────────────
/**
 * Registration for an LLM provider plugin (e.g. ollama, openrouter).
 * Providers are sorted by precedence (ascending); lower number = higher priority.
 */
export type DroneLlmProviderRegistration = {
  /** Unique id for this provider (e.g. 'ollama', 'openrouter'). */
  id: string;
  /** Precedence value. Lower number = higher priority. */
  /**
   * @deprecated Legacy registration path retained for the migration window.
   * Protocol plugins now register drivers via DroneLlmCapability.registerDriver.
   */
  precedence: number;
  /** Get the DroneLlmProvider implementation. */
  getProvider: () => DroneLlmProvider;
  /** List available model identifiers. */
  listModels: () => Promise<string[]>;
  /** The default model to use when this provider is activated. */
  getDefaultModel: () => string;
  hasVision?: (model: string) => boolean | Promise<boolean>;
};

export type { LlmProtocolDriver as DroneLlmProtocolDriver } from './provider-config-types.js';
