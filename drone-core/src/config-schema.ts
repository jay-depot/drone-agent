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

// ── Helper schemas ───────────────────────────────────────────────────

const NonEmptyString = Type.String({ minLength: 1 });
const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });
const PositiveInteger = Type.Integer({ exclusiveMinimum: 0 });
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
const Percent = Type.Number({ exclusiveMinimum: 0, maximum: 100 });

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
    }),
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
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, varName: string) => {
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
