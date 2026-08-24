// ── Drone Core: Public API ─────────────────────────────────────────
//
// This file re-exports all public types and utilities from the drone-core
// library. The implementation is split across multiple modules:
//
//   - position-types.ts  : Position resolution types (AmbiguousPositionError)
//   - config-types.ts     : Configuration types and helpers
//   - session-types.ts    : Session, message, tool, and token types
//   - lsp-types.ts        : LSP server types
//   - mcp-types.ts        : MCP server types
//   - skill-types.ts      : Skill definition types
//   - persona-types.ts    : Persona definition and capability types
//   - domain-types.ts     : Domain types for beacon/coordinator
//   - provider-types.ts   : Provider types for brokers
//   - capabilities.ts     : Capability registry types
//   - plugin-system.ts    : Plugin infrastructure types
//   - utils.ts            : Utility functions
//   - runtime-flags.ts    : Runtime flag registry for system prompt injection
//   - tool-registry.ts    : ToolRegistry class
//   - token-estimate.ts   : Token estimation functions
//   - config-schema.ts     : Config schema and parsing
//   - wiki-types.ts       : Wiki page types for swarm knowledge base
//
// -----------------------------------------------------------------------

// ── Position types ──────────────────────────────────────────────────

export type { AmbiguousMatch } from './position-types.js';
export {
  AmbiguousPositionError,
  buildAmbiguousMatches,
  HARD_CONTEXT_LINES,
  SOFT_CONTEXT_LINES,
} from './position-types.js';

// ── Config types ────────────────────────────────────────────────────

export {
  PRECEDENCE_SWARM,
  PRECEDENCE_COORDINATOR,
  PRECEDENCE_USER,
  PRECEDENCE_PERSONA_USER,
  PRECEDENCE_PROJECT,
  PRECEDENCE_PERSONA_PROJECT,
  PRECEDENCE_LLM_PROVIDER,
} from './config-types.js';

export type {
  DronePluginDependency,
  DronePluginMetadata,
  DroneReasoningLevel,
  DroneOllamaConfig,
  DroneLlmConfig,
  DroneOpenAiModelConfig,
  DroneOpenAiConfig,
  DroneAnthropicModelConfig,
  DroneAnthropicConfig,
  DroneOpenRouterModelConfig,
  DroneOpenRouterConfig,
  DroneSessionConfig,
  DroneGuardrailThresholdConfig,
  DroneGuardrailConfig,
  DroneCompactionStrategy,
  DroneCompactionConfig,
  DroneMemoryConfig,
  DroneLogConfig,
  DroneTerminalConfig,
  DronePromptFileConfig,
  DroneKnowledgeSyncConfig,
  DroneSwarmConfig,
  DroneSearchPath,
  DroneSearchConfig,
  DroneLspSpawnServerConfig,
  DroneLspExternalServerConfig,
  DroneLspServerConfig,
  DroneLspConfig,
  DroneMcpStdioServerConfig,
  DroneMcpStreamableHttpServerConfig,
  DroneMcpServerConfig,
  DroneMcpRoot,
  DroneMcpConfig,
  DroneAgentConfig,
  PartialDroneAgentConfig,
  DroneConfigScope,
  DroneConfigLayer,
  DroneResolvedConfig,
} from './config-types.js';

export {
  createDefaultAgentConfig,
  applyAgentConfigLayer,
} from './config-types.js';

// ── Session types ────────────────────────────────────────────────────

export type {
  DroneLogger,
  DroneImageContent,
  DroneToolJsonSchemaProperty,
  DroneToolJsonSchema,
  DroneChatMessage,
  DroneSessionMessage,
  DroneSessionTurn,
  DroneToolCall,
  DroneToolDescriptor,
  DroneChatResponse,
  DroneContextWindowInfo,
  DroneTokenEstimate,
  DroneSessionSafetyTrimPayload,
  DroneConversationEvent,
  SessionStatus,
  ToolRenderState,
} from './session-types.js';

export { SESSION_STATUSES } from './session-types.js';

// ── Skill types ────────────────────────────────────────────────────

export type { DroneSkillDefinition } from './skill-types.js';

// ── Persona types ────────────────────────────────────────────────────

export type {
  DronePersonaDefinition,
  DronePersonaCapability,
} from './persona-types.js';

// ── Domain types ────────────────────────────────────────────────────

export type {
  Persona,
  Skill,
  CreatePersonaRequest,
  CreateSkillRequest,
} from './domain-types.js';

// ── LSP types ───────────────────────────────────────────────────────

export type {
  DroneLspPosition,
  DroneLspRange,
  DroneLspDiagnostic,
  DroneLspHoverResult,
  DroneLspServerState,
  DroneLspInstallSpec,
} from './lsp-types.js';
export type { DroneLspPlatformKey, DroneLspPlatformSpec } from './lsp-types.js';
export {
  commandExistsOnPath,
  resolveDroneExecutable,
  type ResolveDroneExecutableOptions,
} from './utils.js';

// ── MCP types ───────────────────────────────────────────────────────

export type {
  DroneMcpServerState,
  DroneMcpMountedToolMeta,
  DroneMcpPromptArgument,
  DroneMcpPromptMeta,
  DroneMcpResourceMeta,
  DroneMcpResourceTemplateMeta,
  DroneMcpError,
} from './mcp-types.js';

// ── Provider types ──────────────────────────────────────────────────

export type {
  DroneSkillProvider,
  DroneRecallEnhancer,
  DronePersonaProvider,
  DronePersonaWriter,
  DroneSkillWriter,
  DroneLlmProvider,
  DroneChatRequest,
  DroneLlmProviderRegistration,
} from './provider-types.js';

// ── Provider/protocol/model config types ─────────────────────────────

export type {
  DroneAutoImportMode,
  DroneModelEntryConfig,
  DroneProviderConfig,
  ResolvedProviderConfig,
  DiscoveredModel,
  LlmParameterSpec,
  LlmParameterSchema,
  LlmProtocolDriver,
} from './provider-config-types.js';

export type { ModelSelection } from './model-selection.js';
export {
  parseModelSelection,
  formatModelSelection,
  isValidFullModelSelection,
  resolveInteractiveSelection,
} from './model-selection.js';

// ── Capability types ─────────────────────────────────────────────────

export type {
  DroneConfigInjector,
  DroneConfigCapability,
  DroneSkillsCapability,
  DroneLlmCapability,
  DronePrincipleEntry,
  DronePrinciplesCapability,
  DroneInsightEntry,
  DroneInsightStorageEngine,
  DronePrincipleStorageEngine,
  DroneSelfImprovementCapability,
  DroneEmbeddingProvider,
  DroneSearchCapability,
  SearchResult,
  IndexResult,
  DroneSwarmCapability,
} from './capabilities.js';

// ── Wiki types ────────────────────────────────────────────────────────

export type {
  DroneWikiPageMeta,
  DroneWikiPage,
  DroneWikiSearchResult,
} from './wiki-types.js';

// ── Plugin system types ──────────────────────────────────────────────

export type {
  DronePlugin,
  DroneToolDefinition,
  DroneToolExecutionContext,
  DronePromptFragment,
  DronePluginHooks,
  DroneStandardHookName,
  DronePluginRegistration,
  DroneElicitationQuestionChoice,
  DroneElicitationQuestion,
  DroneElicitationAnswers,
  DroneElicitation,
  DroneWorkflowContext,
  DroneWorkflowResult,
  DroneWorkflowRunReturn,
  DroneWorkflow,
  DroneSlashCommandContext,
  DroneSlashCommand,
} from './plugin-system.js';

// ── Utils ───────────────────────────────────────────────────────────

export { deepMerge } from './deep-merge.js';
export type { MergeSpec } from './deep-merge.js';

export {
  matchGlob,
  filterByGlobPatterns,
  createConsoleLogger,
  getCanonicalToolName,
} from './utils.js';

// ── ToolRegistry ──────────────────────────────────────────────────────

export { ToolRegistry } from './tool-registry.js';
// ── Sorted Registry ─────────────────────────────────────────────────

export {
  insertSortedByPrecedence,
  removeById,
  insertWriterSorted,
} from './sorted-registry.js';

// ── Token estimation ─────────────────────────────────────────────────

export {
  estimateSessionBudget,
  estimateMessageTokens,
  estimateTurnTokens,
  estimateToolDescriptorTokens,
  estimateTextTokens,
} from './token-estimate.js';

// ── Config schema ───────────────────────────────────────────────────

export {
  PartialDroneAgentConfigSchema,
  parseConfigWithSchema,
  transformEnvVars,
  validateProviders,
} from './config-schema.js';
export type { PartialDroneAgentConfigDecoded } from './config-schema.js';

// ── Runtime flags ────────────────────────────────────────────────────

export type { RuntimeFlagRegistry } from './runtime-flags.js';
export { createRuntimeFlagRegistry } from './runtime-flags.js';

// ── Debug flags ─────────────────────────────────────────────────────

export type { DebugFlagRegistry } from './debug-flags.js';
export { createDebugFlagRegistry } from './debug-flags.js';
