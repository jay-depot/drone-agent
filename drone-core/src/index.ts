// ── Drone Core: Public API ─────────────────────────────────────────
//
// This file re-exports all public types and utilities from the drone-core
// library. The implementation is split across multiple modules:
//
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
//   - token-estimate.ts   : Token estimation functions
//   - config-schema.ts     : Config schema and parsing
//
// -----------------------------------------------------------------------

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
  DroneOllamaConfig,
  DroneLlmConfig,
  DroneOpenRouterModelConfig,
  DroneOpenRouterConfig,
  DroneSessionConfig,
  DroneCompactionStrategy,
  DroneCompactionConfig,
  DroneMemoryConfig,
  DroneLogConfig,
  DronePromptFileConfig,
  DroneKnowledgeSyncConfig,
  DroneSwarmConfig,
  DroneLspSpawnServerConfig,
  DroneLspExternalServerConfig,
  DroneLspServerConfig,
  DroneLspConfig,
  DroneMcpStdioServerConfig,
  DroneMcpStreamableHttpServerConfig,
  DroneMcpServerConfig,
  DroneMcpConfig,
  DroneAgentConfig,
  PartialDroneAgentConfig,
  DroneConfigScope,
  DroneConfigLayer,
  DroneResolvedConfig,
  DroneSessionPhase,
} from './config-types.js';

export {
  createDefaultAgentConfig,
  applyAgentConfigLayer,
} from './config-types.js';

// ── Session types ────────────────────────────────────────────────────

export type {
  DroneLogger,
  DroneToolJsonSchemaProperty,
  DroneToolJsonSchema,
  DroneChatMessage,
  DroneSessionMessage,
  DroneSessionTurn,
  DroneSessionState,
  DroneToolCall,
  DroneToolDescriptor,
  DroneChatResponse,
  DroneContextWindowInfo,
  DroneTokenEstimate,
  DroneSessionSafetyTrimPayload,
} from './session-types.js';

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
} from './lsp-types.js';

// ── MCP types ───────────────────────────────────────────────────────

export type {
  DroneMcpServerState,
  DroneMcpMountedToolMeta,
  DroneMcpPromptArgument,
  DroneMcpPromptMeta,
  DroneMcpResourceMeta,
  DroneMcpError,
} from './mcp-types.js';

// ── Provider types ──────────────────────────────────────────────────

export type {
  DroneSkillProvider,
  DroneRecallEnhancer,
  DronePersonaProvider,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
} from './provider-types.js';

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
} from './capabilities.js';

// ── Plugin system types ──────────────────────────────────────────────

export type {
  DronePlugin,
  DroneToolDefinition,
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
  DroneMacroStep,
  DroneMacroDefinition,
} from './plugin-system.js';

// ── Utils ───────────────────────────────────────────────────────────

export {
  matchGlob,
  filterByGlobPatterns,
  createConsoleLogger,
  getCanonicalToolName,
} from './utils.js';

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
} from './config-schema.js';
export type { PartialDroneAgentConfigDecoded } from './config-schema.js';
