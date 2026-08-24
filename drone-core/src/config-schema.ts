/**
 * TypeBox schemas for drone-agent configuration.
 *
 * Defines the full config schema using @sinclair/typebox, which provides
 * runtime validation + TypeScript type inference from a single source of
 * truth. Replaces the hand-rolled validation helpers in
 * drone-agent/src/runtime/config.ts.
 */

import { type StaticDecode, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type {
  DroneProviderConfig,
  ProviderConfigValidationResult,
} from './provider-config-types.js';
export type { ProviderConfigValidationResult };

// ── Helper schemas ───────────────────────────────────────────────────

const NonEmptyString = Type.String({ minLength: 1 });
const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });
const PositiveInteger = Type.Integer({ exclusiveMinimum: 0 });
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
const Percent = Type.Number({ exclusiveMinimum: 0, maximum: 100 });

const GuardrailThresholdSchema = Type.Object({
  hintAfter: Type.Optional(NonNegativeInteger),
  maxHints: Type.Optional(NonNegativeInteger),
});

const GuardrailSchema = Type.Object({
  brokenResponses: Type.Optional(GuardrailThresholdSchema),
  reasoningOnlyResponses: Type.Optional(GuardrailThresholdSchema),
  identicalToolCalls: Type.Optional(GuardrailThresholdSchema),
});

// ── OpenRouter model config (used in both standalone and nested) ─────

const OpenRouterModelConfigSchema = Type.Object({
  id: NonEmptyString,
  contextWindow: PositiveNumber,
});

const OpenAiModelConfigSchema = Type.Object({
  id: NonEmptyString,
  contextWindow: PositiveNumber,
});

const AnthropicModelConfigSchema = Type.Object({
  id: NonEmptyString,
  contextWindow: PositiveNumber,
});

// ── Provider config (new provider/model format) ─────────────────────

const DroneModelEntrySchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1 })),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  contextWindow: Type.Optional(PositiveNumber),
  maxOutputTokens: Type.Optional(PositiveInteger),
  hasVision: Type.Optional(Type.Boolean()),
  supportsTools: Type.Optional(Type.Boolean()),
  reasoningLevel: Type.Optional(
    Type.Union([
      Type.Literal('off'),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('max'),
    ])
  ),
});

export const DroneProviderSchema = Type.Object({
  protocol: NonEmptyString,
  baseUrl: Type.Optional(NonEmptyString),
  apiKey: Type.Optional(Type.String()),
  apiVersion: Type.Optional(NonEmptyString),
  orgId: Type.Optional(NonEmptyString),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  autoImport: Type.Optional(
    Type.Union([
      Type.Literal('off'),
      Type.Literal('onSelect'),
      Type.Literal('all'),
    ])
  ),
  models: Type.Optional(Type.Record(Type.String(), DroneModelEntrySchema)),
});

// ── LSP server configs ──────────────────────────────────────────────

const LspSpawnServerConfigSchema = Type.Object({
  transport: Type.Optional(Type.Literal('stdio')),
  language: Type.Optional(Type.String()),
  command: NonEmptyString,
  args: Type.Optional(Type.Array(Type.String())),
  fileExtensions: Type.Optional(Type.Array(Type.String())),
  rootPatterns: Type.Optional(Type.Array(Type.String())),
  autoInstall: Type.Optional(Type.Boolean()),
});

const LspExternalServerConfigSchema = Type.Object({
  transport: Type.Literal('tcp'),
  language: Type.Optional(Type.String()),
  host: NonEmptyString,
  port: PositiveInteger,
  fileExtensions: Type.Optional(Type.Array(Type.String())),
  rootPatterns: Type.Optional(Type.Array(Type.String())),
});

const LspServerConfigSchema = Type.Union([
  LspSpawnServerConfigSchema,
  LspExternalServerConfigSchema,
]);

// ── MCP server configs ──────────────────────────────────────────────

const McpStdioServerConfigSchema = Type.Object({
  transport: Type.Optional(Type.Literal('stdio')),
  command: NonEmptyString,
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  requestTimeoutMs: Type.Optional(PositiveNumber),
  retryCount: Type.Optional(NonNegativeInteger),
  retryDelayMs: Type.Optional(NonNegativeNumber),
  maxListPages: Type.Optional(PositiveInteger),
  maxListItems: Type.Optional(PositiveInteger),
  encoding: Type.Optional(
    Type.Union([Type.Literal('content-length'), Type.Literal('line-delimited')])
  ),
});

const McpStreamableHttpServerConfigSchema = Type.Object({
  transport: Type.Literal('streamable_http'),
  url: NonEmptyString,
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  requestTimeoutMs: Type.Optional(PositiveNumber),
  retryCount: Type.Optional(NonNegativeInteger),
  retryDelayMs: Type.Optional(NonNegativeNumber),
  maxListPages: Type.Optional(PositiveInteger),
  maxListItems: Type.Optional(PositiveInteger),
  compatibilityMode: Type.Optional(
    Type.Union([Type.Literal('strict'), Type.Literal('permissive')])
  ),
});

const McpServerConfigSchema = Type.Union([
  McpStdioServerConfigSchema,
  McpStreamableHttpServerConfigSchema,
]);

// ── Top-level partial config schema ───────────────────────────────────
// Every nested property is Optional so that partial configs (user/project
// layers that only set a few fields) validate correctly.

export const PartialDroneAgentConfigSchema = Type.Partial(
  Type.Object({
    enabledPlugins: Type.Array(Type.String()),
    externalPlugins: Type.Optional(Type.Array(Type.String())),
    trustedPlugins: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.Literal('trusted'), Type.Literal('untrusted')])
      )
    ),
    systemPrompt: Type.String(),
    activePersona: Type.Union([Type.String(), Type.Null()]),
    ollama: Type.Object({
      host: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    llm: Type.Object({
      provider: Type.Optional(Type.String()),
      active: Type.Optional(
        Type.String({
          pattern: '^[^/]+/.+',
        })
      ),
      reasoningLevel: Type.Optional(
        Type.Union([
          Type.Literal('off'),
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high'),
          Type.Literal('max'),
        ])
      ),
    }),
    providers: Type.Record(Type.String(), DroneProviderSchema),
    openrouter: Type.Object({
      apiKey: Type.Optional(Type.String()),
      defaultModel: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(OpenRouterModelConfigSchema)),
    }),
    openai: Type.Object({
      apiKey: Type.Optional(Type.String()),
      defaultModel: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
      orgId: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(OpenAiModelConfigSchema)),
    }),
    anthropic: Type.Object({
      apiKey: Type.Optional(Type.String()),
      defaultModel: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
      apiVersion: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(AnthropicModelConfigSchema)),
    }),
    session: Type.Object({
      contextWindowTokens: Type.Optional(PositiveNumber),
      responseReserveTokens: Type.Optional(PositiveNumber),
      maxToolIterations: Type.Optional(PositiveInteger),
      promptOnToolIterationLimit: Type.Optional(Type.Boolean()),
      maxToolResultTokensPercent: Type.Optional(Percent),
      guardrail: Type.Optional(GuardrailSchema),
    }),
    lsp: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      diagnosticTokenBudget: Type.Optional(PositiveNumber),
      requestTimeoutMs: Type.Optional(PositiveNumber),
      preferExternal: Type.Optional(Type.Boolean()),
      autoInstall: Type.Optional(Type.Boolean()),
      servers: Type.Optional(Type.Record(Type.String(), LspServerConfigSchema)),
    }),
    mcp: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      requestTimeoutMs: Type.Optional(PositiveNumber),
      retryCount: Type.Optional(NonNegativeInteger),
      retryDelayMs: Type.Optional(NonNegativeNumber),
      maxListPages: Type.Optional(PositiveInteger),
      maxListItems: Type.Optional(PositiveInteger),
      compatibilityMode: Type.Optional(
        Type.Union([Type.Literal('strict'), Type.Literal('permissive')])
      ),
      servers: Type.Optional(Type.Record(Type.String(), McpServerConfigSchema)),
    }),
    compaction: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      strategy: Type.Optional(Type.Literal('summary-drop')),
      softThresholdPercent: Type.Optional(Percent),
      slicePercent: Type.Optional(Percent),
      minTurnsToCompact: Type.Optional(PositiveInteger),
      summaryMaxTokens: Type.Optional(PositiveNumber),
      summaryBudgetPercent: Type.Optional(Percent),
      nudgeMarginPercent: Type.Optional(Percent),
    }),
    memory: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
    }),
    log: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
    }),
    terminal: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      maxActiveSessions: Type.Optional(PositiveInteger),
      defaultShell: Type.Optional(Type.String()),
      defaultCols: Type.Optional(PositiveInteger),
      defaultRows: Type.Optional(PositiveInteger),
    }),
    promptFile: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      files: Type.Optional(Type.Array(Type.String())),
    }),
    search: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      paths: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String(),
            embeddingProvider: Type.Optional(Type.String()),
            includeHidden: Type.Optional(
              Type.Boolean({
                description:
                  'Intended future functionality — not yet honored. .git and node_modules are always excluded.',
              })
            ),
            includeNodeModules: Type.Optional(
              Type.Boolean({
                description:
                  'Intended future functionality — not yet honored. .git and node_modules are always excluded.',
              })
            ),
            exclude: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  'Glob patterns (minimatch) applied to each file path relative to this search root, excluding matches from semantic search results. Applied at query time.',
              })
            ),
          })
        )
      ),
      userEmbeddingProvider: Type.Optional(Type.String()),
      projectEmbeddingProvider: Type.Optional(Type.String()),
    }),
    swarm: Type.Object({
      knowledgeSync: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          pushInsights: Type.Optional(Type.Boolean()),
          pullOnStartup: Type.Optional(Type.Boolean()),
          pullIntervalMinutes: Type.Optional(PositiveInteger),
        })
      ),
      beaconHost: Type.Optional(Type.String()),
      beaconPort: Type.Optional(PositiveInteger),
      beaconUseHttps: Type.Optional(Type.Boolean()),
      sessionId: Type.Optional(Type.String()),
    }),
  })
);

/** Inferred type matching PartialDroneAgentConfig from drone-core. */
export type PartialDroneAgentConfigDecoded = StaticDecode<
  typeof PartialDroneAgentConfigSchema
>;

// ── Env var interpolation ────────────────────────────────────────────

/**
 * Recursively walk a parsed config object and replace `${VAR}` patterns
 * in string values with the corresponding environment variable.
 * Throws if a referenced env var is not set.
 */
export function transformEnvVars(
  value: unknown,
  source: string,
  keyPath: string = ''
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, varName: string) => {
      const resolved = process.env[varName];
      if (resolved === undefined) {
        throw new Error(
          `Invalid config in ${source}: ${keyPath} references unset environment variable ${varName}.`
        );
      }
      return resolved;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      transformEnvVars(item, source, `${keyPath}[${index}]`)
    );
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = transformEnvVars(v, source, keyPath ? `${keyPath}.${k}` : k);
    }
    return result;
  }

  return value;
}

// ── Parse function ───────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON config value against the schema.
 * Returns the decoded config with env vars interpolated.
 * Throws on invalid input with a descriptive error message.
 */
export function parseConfigWithSchema(
  raw: unknown,
  source: string
): PartialDroneAgentConfigDecoded {
  // Use Decode for strict validation (no coercion).
  // If it fails, collect all errors for a descriptive message.
  if (!Value.Check(PartialDroneAgentConfigSchema, raw)) {
    const errors = [...Value.Errors(PartialDroneAgentConfigSchema, raw)];
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `Invalid config in ${source}: ${first.message} at ${first.path || 'root'}.`
      );
    }
    throw new Error(`Invalid config in ${source}: validation failed.`);
  }
  const decoded = Value.Decode(PartialDroneAgentConfigSchema, raw);
  return transformEnvVars(decoded, source) as PartialDroneAgentConfigDecoded;
}

/**
 * Semantic validation for the providers section, run after the full config
 * merge (defaults → user → project → swarm underlays). Structural shape is
 * enforced by the schema at parse time; these are the cross-cutting rules:
 *
 * - provider ids must be non-empty and slash-free
 * - every entry must declare a protocol
 * - model aliasing must stay one level deep (chains/self-aliases warn)
 *
 * Returns errors/warnings rather than throwing so callers can surface all
 * problems at once.
 */
export function validateProviders(
  providers: Record<string, DroneProviderConfig>
): ProviderConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId.length === 0 || providerId.includes('/')) {
      errors.push(
        `Provider id "${providerId}" must be non-empty and slash-free (it forms the prefix of <providerId>/<modelLocalId>).`
      );
      continue;
    }
    if (!provider.protocol || provider.protocol.trim().length === 0) {
      errors.push(
        `Provider "${providerId}" is missing required field "protocol".`
      );
      continue;
    }

    const models = provider.models ?? {};
    const declaredKeys = new Set(Object.keys(models));
    for (const [localId, entry] of Object.entries(models)) {
      const target = entry.model;
      if (target === undefined) continue;
      if (target === localId) {
        warnings.push(
          `Model "${providerId}/${localId}" aliases itself; the alias is ignored.`
        );
        continue;
      }
      if (!declaredKeys.has(target)) continue;
      const targetAlias = models[target]?.model;
      if (targetAlias !== undefined) {
        warnings.push(
          `Alias chain detected: "${providerId}/${localId}" → "${providerId}/${target}" → "${targetAlias}". Only one alias level resolves.`
        );
      }
    }
  }

  return { errors, warnings };
}
