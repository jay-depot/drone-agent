// ── Provider types for skill/persona/llm broker architecture ───────

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

export type DroneLlmProvider = {
  chat: (input: {
    model: string;
    messages: DroneChatMessage[];
    tools?: DroneToolDescriptor[];
  }) => Promise<DroneChatResponse>;
  getContextWindowInfo?: (input: {
    model: string;
  }) => Promise<DroneContextWindowInfo | null>;
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
  precedence: number;
  /** Get the DroneLlmProvider implementation. */
  getProvider: () => DroneLlmProvider;
  /** List available model identifiers. */
  listModels: () => Promise<string[]>;
  /** The default model to use when this provider is activated. */
  getDefaultModel: () => string;
};
