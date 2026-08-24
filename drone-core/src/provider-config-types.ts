// ── Provider/protocol/model configuration types ─────────────────────
//
// Providers are DATA (entries in `config.providers`); protocols are CODE
// (plugins exporting an `LlmProtocolDriver`). The `llm` broker plugin
// instantiates one DroneLlmProvider per configured provider entry using
// the driver exported by the entry's protocol plugin.

import type { DroneReasoningLevel } from './config-types.js';
import type { DroneLlmProvider } from './provider-types.js';

/** Policy for persisting discovered models into config as stub entries. */
export type DroneAutoImportMode = 'off' | 'onSelect' | 'all';

/**
 * A user-declared model entry inside a provider. The map KEY is the local
 * reference id used for selection (`<providerId>/<key>`); the optional
 * `model` field is the upstream id sent on the wire (defaults to the key,
 * giving one level of aliasing).
 */
export type DroneModelEntryConfig = {
  /**
   * Upstream model id sent to the provider. Defaults to the entry key.
   * May point at another declared key of the same provider (one level of
   * aliasing only — chains produce a validation warning).
   */
  model?: string;
  /** Model-level parameter overrides (shallow-merged over provider params). */
  parameters?: Record<string, unknown>;
  contextWindow?: number;
  maxOutputTokens?: number;
  hasVision?: boolean;
  supportsTools?: boolean;
  /** Per-model reasoning level (sits between session override and llm-level). */
  reasoningLevel?: DroneReasoningLevel;
};

/**
 * A user-defined LLM provider entry under `config.providers.<id>`.
 * `apiKey` may be a literal secret or a `${VAR}` template resolved
 * after the full config merge.
 */
export type DroneProviderConfig = {
  /** Protocol plugin id: 'ollama' | 'openai' | 'openrouter' | 'anthropic'. */
  protocol: string;
  baseUrl?: string;
  /** Literal API key OR `${VAR}` template. */
  apiKey?: string;
  apiVersion?: string;
  orgId?: string;
  headers?: Record<string, string>;
  /** Provider-level parameters (every model inherits, model wins per key). */
  parameters?: Record<string, unknown>;
  /** Raw passthrough bag merged silently into native request payloads. */
  extra?: Record<string, unknown>;
  /** Whether discovered models are persisted as `{}` stubs. Default 'onSelect'. */
  autoImport?: DroneAutoImportMode;
  /** Declared models keyed by local reference id. */
  models?: Record<string, DroneModelEntryConfig>;
};

/** A provider config whose `${VAR}` templates have been interpolated. */
export type ResolvedProviderConfig = DroneProviderConfig;

/**
 * A model reported by a driver's `discoverModels()`. Field-for-field this
 * mirrors the declarable metadata so the merge (declared wins key-for-key)
 * is trivial.
 */
export type DiscoveredModel = {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  hasVision?: boolean;
  supportsTools?: boolean;
};

/** Type constraint for a single tunable parameter. */
export type LlmParameterSpec = {
  type: 'number' | 'string' | 'boolean' | 'string[]';
  description?: string;
};

/** Driver-owned table describing the parameters it understands. */
export type LlmParameterSchema = {
  parameters: Record<string, LlmParameterSpec>;
};

/**
 * Factory exported by a protocol plugin (via offer `llm-driver.<protocolId>`).
 * The broker calls `createProvider()` once per matching `config.providers`
 * entry; `discoverModels` and `parameterSchema` are optional facilities.
 */
export type LlmProtocolDriver = {
  protocolId: string;
  createProvider: (providerConfig: ResolvedProviderConfig) => DroneLlmProvider;
  discoverModels?: (
    providerConfig: DroneProviderConfig
  ) => Promise<DiscoveredModel[]>;
  parameterSchema: LlmParameterSchema;
};

/** Semantic-validation outcome for a providers config map. */
export type ProviderConfigValidationResult = {
  /** Fatal problems (empty/slashful ids, missing protocol). */
  errors: string[];
  /** Non-fatal problems (alias chains, self aliases). */
  warnings: string[];
};
