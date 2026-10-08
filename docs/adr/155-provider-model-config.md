---
id: decisions/155-provider-model-config
title: Provider/protocol/model configuration refactor
tags: [decision, architecture, llm, config, providers]
related:
  [
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
    modules/drone-agent.md,
    concepts/broker-provider.md,
    entities/DroneAgentConfig.md,
    flows/startup.md,
  ]
date: 2026-08-23
status: accepted
---

# 155 — Provider/protocol/model configuration refactor

**Summary**: LLM configuration is restructured into **protocol plugins** (code: ollama, openai, openrouter, anthropic, echo, each exporting an `LlmProtocolDriver`) and **user-defined providers** (data: entries in `config.providers` with nested models, parameters, and metadata), selected via canonical `<providerId>/<modelLocalId>` identity, with `${VAR}` secret interpolation, scope policies, and automatic migration from the legacy per-provider sections.

## Context

Every provider plugin previously invented its own model handling:

- **Three model-list regimes**: ollama probed live HTTP; openai/openrouter/anthropic read hand-curated `models[]` arrays in their own config sections; echo used env singletons.
- **Zero sampling parameters** anywhere — no temperature, no `num_ctx`, nothing.
- **Three copy-pasted reasoning mappers** with divergent `off` semantics (ollama → `think:false`, openai-family → `"none"`).
- **Cross-wired fallbacks**: the conversation service resolved reasoning as session → `config.llm.reasoningLevel` → `config.ollama.reasoningLevel` → `config.openrouter.reasoningLevel`, consulting sections belonging to _inactive_ providers.
- **Asymmetric vision detection**: ollama guessed vision by model-name substrings (a list that always rots); anthropic hardcoded true; openai-family had none.
- **A dead `--model` CLI flag** parsed but never consumed.
- The anthropic plugin **borrowed `session.responseReserveTokens`** as its wire `max_tokens`, conflating context budgeting with output limits.

Config sections (`llm`/`ollama`/`openai`/`anthropic`/`openrouter`) leaked protocol details everywhere.

## Decision

### Protocols are code, providers are data

Each protocol plugin exports an `LlmProtocolDriver` registered with the llm broker via a new `DroneLlmCapability.registerDriver(driver)` method:

```typescript
type LlmProtocolDriver = {
  protocolId: string;
  createProvider(providerConfig: ResolvedProviderConfig): DroneLlmProvider;
  discoverModels?(providerConfig): Promise<DiscoveredModel[]>;
  parameterSchema: LlmParameterSchema;
};
```

The broker instantiates one `DroneLlmProvider` per matching `config.providers` entry. Plugin IDs are unchanged, so existing `enabledPlugins` keep working; all protocol plugins become default-enabled but **inert without configured providers** — the real gate is the providers map itself.

The driver is delivered through `registerDriver` because the engine's capability model has no reverse direction: `offer()` stores under the _offering_ plugin's id and `request()` only resolves declared dependencies, so a broker can never request capabilities from plugins that depend on it. `registerDriver` mirrors the existing `registerProvider` flow exactly.

### Providers in config

```jsonc
{
  "providers": {
    "local": {
      "protocol": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "parameters": { "temperature": 0.7 },
      "models": {
        "llama3.1": {},
        "fast": { "model": "llama3.1", "parameters": { "numCtx": 8192 } },
      },
    },
    "cloud": {
      "protocol": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}",
      "autoImport": "onSelect",
    },
  },
  "llm": { "active": "local/fast" },
}
```

Model entries alias via an optional `model` field (the upstream wire id; defaults to the key). One level of aliasing only — chains warn at startup and resolve one level deep.

### Hybrid model sourcing

Optional `discoverModels()` per driver merges discovered ⊕ declared models (declared wins key-for-key) behind a ~60s TTL cache; discovery failure falls back to declared-only with a non-fatal warning. Per-provider `autoImport: 'off' | 'onSelect' | 'all'` (default `onSelect`) governs persisting discovered ids as empty `{}` stubs that pin existence without snapshotting metadata.

### Broker enrichment

The broker wraps each instantiated provider's `chat()`: it fills the additive `DroneChatRequest` fields (`parameters`, `extra`, `maxOutputTokens`, `hasVision`) before delegating. Effective parameters = `provider.parameters ⊕ model.parameters`, shallow merge with model winning per key; aliased entries inherit the base entry's parameters first. Keys absent from the driver's `parameterSchema` warn-but-send; the provider-level `extra` bag merges silently. The `DroneLlmProvider.chat()` wire contract keeps its leading fields untouched, so conversation-service, compaction, MCP summarizer, and gateway spawn flows needed no changes.

Metadata resolution order for every field (`contextWindow`, `maxOutputTokens`, `hasVision` default false, `supportsTools` default true, `reasoningLevel`): declared > alias-base > discovered > defaults. Anthropic supplies `hasVision: true` via a static discovery stub; ollama reads `/api/show` capability flags (the name-substring heuristic died).

### Canonical selection

A selected model is `<providerId>/<modelLocalId>` split on the **first slash**, so multi-slash upstream ids (OpenRouter-style) survive intact. Config values require the full form; interactive surfaces accept bare local ids as shorthand within the active provider. `/model` browses grouped by provider; `/model <pick>` persists to user-scope `llm.active`; `/model --once <pick>` switches without persisting; `--model <provider/model>` is an invocation-scoped override applied after broker activation and never persisted.

### Secrets & scopes

`${VAR}` interpolation runs at layer parse time (per-layer ≡ post-merge since env is node-local); unresolved variables fail startup naming the variable and path. Project-scope files may **not** define `providers` (startup error) nor plaintext apiKeys (loud warning); user scope and swarm underlays remain sanctioned channels. Projects may pin `llm.active`/`llm.reasoningLevel`.

### Reasoning chain

Session (`/reasoning`) > selected model entry's `reasoningLevel` > `llm.reasoningLevel`. Cross-wired legacy fallbacks were deleted. Driver-owned mapping tables replace the copy-pasted mappers: ollama → `think:false | '<level>'`; openai-family → `reasoning_effort`, with `off → 'minimal'` (changed from `'none'`); anthropic → thinking budgets as calibrated fractions of maxOutputTokens (low ≈10%, others ≈50%). Raw pass-through warns.

### Migration

On load, if `providers` is empty and legacy sections exist, a self-contained module (`runtime/provider-migration.ts`, deletable when the window closes) synthesizes providers named after each section and seeds `llm.active`. Idempotent, never overwrites an existing `llm.active`, announces a deprecation notice surfaced on `DroneResolvedConfig.migrationNotice`. All built-in writers (bootstrap, first-run, `/model`) emit new format only. Legacy section _reads_ outside the migration module are gone.

## Consequences

**Intentional behavior change**: anthropic wire `max_tokens` now comes from resolved `maxOutputTokens` metadata (driver default 8192 when undeclared) instead of borrowing `session.responseReserveTokens`, which returns to pure context-budgeting duty. Payload-equivalence tests pin every other provider byte-for-byte against the legacy behavior.

Validation: typecheck/build/lint clean workspace-wide; fast suite 2072 passed / 0 failed; 71 new units across migration/validation/resolution/driver tables/discovery/selection/scope-policy/payload-equivalence; manual smoke against live local ollama confirmed migrated-config chat, `options.num_ctx` on the wire, and `--model` override.

Follow-ups: onSelect stub-writing is plumbed but currently a no-op in the `/model` persistence path; legacy types stay until the deprecation window closes; the swarm beacon-config-injector subsystem remains dormant (no consumer of `inject()` anywhere).

## Related

- provider-model-selection — the selection identity + resolution chain reference
- [drone-core](../../drone-core/) — foundation types (`provider-config-types.ts`, `model-selection.ts`)
- [drone-agent-plugins](../../drone-agent/src/plugins/) — protocol plugin rows
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — the `providers` section schema
