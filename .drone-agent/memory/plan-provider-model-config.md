---
key: plan-provider-model-config
tags:
  - plan
  - llm
  - providers
  - refactor
created: 2026-08-23T00:35:15.967Z
updated: 2026-08-23T00:35:15.967Z
---

# Plan: Provider/Protocol/Model Config Refactor

**Branch:** `feat/provider-model-config` (from main@96b68dd; backlog commit 061cf5d). **Status:** ready for execution. **Strategy:** 7 sequential phases, always-green commits, lands as ONE PR when confirmed working. Execute with the `code` persona; run the final validation step against this plan's Validation Criteria section.

## Summary

Today every LLM provider plugin invents its own model handling: three different model-list regimes (live ollama HTTP vs hand-curated config arrays vs env singleton), zero sampling parameters anywhere, three copy-pasted reasoning mappers with divergent semantics, asymmetric vision detection, a dead `--model` flag, and config sections (`llm`/`ollama`/`openai`/`anthropic`/`openrouter`) that leak protocol details everywhere (conversation-service even cross-wires fallbacks to inactive providers' sections).

This refactor introduces: **protocol plugins** (code: ollama, openai, openrouter, anthropic, echo) exporting `LlmProtocolDriver` factories, and **user-defined providers** (data) in a new `config.providers` map, each with nested `models` supporting aliases and tunable parameters (`temperature`, `numCtx`, `minP`, …), hybrid declared⊕discovered model sourcing, canonical `<providerId>/<modelLocalId>` selection, `${VAR}` secret interpolation, and scope policies (project-scope `providers` banned; swarm underlays remain sanctioned distribution). The `DroneLlmProvider.chat()` wire contract is preserved (additive optional fields only) so conversation-service, compaction, MCP summarizer, and gateway spawn flows stay untouched — except one intentional bug fix: anthropic wire `max_tokens` comes from `maxOutputTokens` metadata instead of borrowing `session.responseReserveTokens`.

## Locked decisions (from grilling session)

1. **Migration** — auto-migrate legacy sections into synthetic providers on load, isolated in its own module for clean deletion later; config writers emit new format only.
2. **Architecture C** — protocols export drivers; evolved `llm` broker instantiates one provider per `config.providers` entry; providers=data, protocols=code.
3. **All protocol plugins default-enabled** (inert without configured providers); real gate = `config.providers`. Future note: auto-write default-enabled plugins into `enabledPlugins` someday.
4. **Hybrid model sourcing** — optional `discoverModels` per driver; merged declared ⊕ discovered, declared wins key-for-key; TTL-cached discovery; failures non-fatal; unknown models addressable with conservative defaults. Per-provider `autoImport: 'off'|'onSelect'|'all'` (default `onSelect`) persisting `{}` stubs only (pin existence, never snapshot metadata); `onSelect` fires only on explicit `/model` picks; `all` never removes stale entries; no recommended-defaults knob; no bundled metadata registry.
5. **Parameters** — flat camelCase `parameters` maps at provider + model level, shallow merge model-wins; driver `parameterSchema` validates (known=type-checked, unknown=warn-but-send, explicit `extra:{}`=silent passthrough); no nested buckets; no session-scoped sampling knobs. **Aliasing:** entry `{ model?, parameters?, ...meta }`; key=local ID, `model`=upstream ID (defaults to key); ONE level only (warn chains); per-field resolution own > base > discovered > defaults; effective list = discovered ∪ declared keys; selection uses local IDs; auto-import writes only discovered upstream IDs.
6. **Metadata** — `contextWindow`, `maxOutputTokens`, `hasVision` (default false), `supportsTools` (default true); resolution declared > alias-base > discovered > defaults; `DroneContextWindowInfo.source` retained. Vision: ollama via /api/show capability flags (heuristics die); anthropic driver supplies `hasVision:true` as discovered metadata; openai-family default false + user declares. Anthropic `max_tokens` fix as above.
7. **Selection** — `<providerId>/<modelLocalId>` everywhere (llm.active, /model, status bar, budget cache key); split on FIRST slash; provider IDs slash-free (validated); bare ID = interactive-only convenience; config requires full form. `--model <provider/model>` becomes invocation-scoped override (no `--provider` flag). `/model <pick>` persists llm.active (+onSelect stub when applicable); `--once` switches without persisting either; bare `/model` read-only. Migration seeds `llm.active`; synthetic providers named `ollama`/`openai`/`anthropic`/`openrouter`.
8. **Secrets** — `${VAR}` interpolation anywhere in provider config + literal keys allowed; unresolved var = validation error; project-scope literal keys warn loudly; user-scope plaintext OK.
9. **Scopes/swarm** — `providers` BANNED in project-scope files (startup error); legacy sections grandfathered during migration window; projects may pin `llm.active`/`llm.reasoningLevel`; beacon/coordinator underlays fully supported; interpolation+validation AFTER full merge (each node resolves env locally). User instruction: relax incrementally if friction arises — INFORM THE USER when it does.
10. **Reasoning** — chain: session (/reasoning) > selected model entry `reasoningLevel` > `llm.reasoningLevel`; cross-wired legacy fallbacks die; driver-owned mapping tables (ollama `think` levels/false; openai-family `reasoning_effort` off→minimal; anthropic `budget_tokens` fractions of maxOutputTokens); raw passthrough w/ warning.
    11a. **Non-goals**: streaming, usage accounting, per-role/persona bindings, bundled metadata registry, unified error/retry, session sampling knobs, Gemini/Responses plugins, echo enhancements. Backlog: project memory `llm-provider-future-work`.
    11b. **OpenRouter = own protocolId** sharing the openai-family wire library (5 protocol plugins total). One PR at the end.

---

## Phase 1 — Foundation types, schema, validation (drone-core)

_Files: `drone-core/src/config-types.ts`, `drone-core/src/config-schema.ts`, `drone-core/src/provider-types.ts`, `drone-core/src/session-types.ts` (types may go in new `drone-core/src/provider-config-types.ts` if cleaner)_

1.1 Types:

```ts
interface DroneProviderConfig {
  protocol: string; // 'ollama' | 'openai' | 'openrouter' | 'anthropic'
  baseUrl?: string;
  apiKey?: string; // literal OR ${VAR} template
  apiVersion?: string;
  orgId?: string; // protocol-specific, validated by driver
  headers?: Record<string, string>;
  parameters?: Record<string, unknown>;
  extra?: Record<string, unknown>; // silent raw passthrough bag
  autoImport?: 'off' | 'onSelect' | 'all'; // default 'onSelect'
  models?: Record<string, DroneModelEntryConfig>;
}
interface DroneModelEntryConfig {
  model?: string; // upstream ID; defaults to key; one-level alias
  parameters?: Record<string, unknown>;
  contextWindow?: number;
  maxOutputTokens?: number;
  hasVision?: boolean;
  supportsTools?: boolean;
  reasoningLevel?: DroneReasoningLevel;
}
interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  hasVision?: boolean;
  supportsTools?: boolean;
}
interface LlmParameterSpec {
  type: 'number' | 'string' | 'boolean' | 'string[]';
  description?: string;
}
interface LlmParameterSchema {
  parameters: Record<string, LlmParameterSchema>;
}
interface LlmProtocolDriver {
  protocolId: string;
  createProvider(providerConfig: ResolvedProviderConfig): DroneLlmProvider;
  discoverModels?(
    providerConfig: DroneProviderConfig
  ): Promise<DiscoveredModel[]>;
  parameterSchema: LlmParameterSchema;
}
```

`ResolvedProviderConfig` = provider config with interpolated values. Extend `DroneChatRequest` ADDITIVELY: optional `parameters?`, `extra?`, `maxOutputTokens?`, `hasVision?` (existing consumers unaffected).

1.2 Config surface: add `providers: Record<string, DroneProviderConfig>` (default `{}`) and `llm.active?: string` to `DroneAgentConfig` + `createDefaultAgentConfig`. Keep legacy sections typed during migration window.

1.3 Merge spec (`CONFIG_MERGE_SPEC`): `providers` merges **entry-level replace** — maps merge by key, but any scope defining `providers.<id>` replaces that whole entry (no intra-entry deep merge; prevents beacon/local frankensteins). `llm` stays shallow-per-key.

1.4 Validation (`config-schema.ts` + loader): provider IDs non-empty & slash-free; `protocol` present; alias `model` value must NOT equal another declared key of the same provider (warn: chain); unknown protocol = warning until drivers load (broker reports definitively); project-scope `providers` = ERROR (enforce where scope provenance is known — see Phase 6 for exact hook point; grandfather legacy sections).

Tests: type/schema units, merge-spec entry-replace case, validation rule cases.

## Phase 2 — Driver conversion (drone-agent plugins)

_Files: `plugins/ollama.ts`, `plugins/openai/index.ts`, `plugins/openrouter/index.ts`, `plugins/anthropic/index.ts`+`anthropic-adapter.ts`, `plugins/echo/index.ts`, `shared/openai-compatible.ts`_

2.1 Export pattern: each protocol plugin additionally `registration.offer({ id: 'llm-driver.<protocolId>', value: driver })`. Broker consumes via optional `requestCapability`. Plugin IDs UNCHANGED (existing enabledPlugins keep working).

2.2 Move wire logic into drivers:

- **ollama**: SDK-based provider becomes `createProvider` product; add `discoverModels` via `/api/tags` + `/api/show` (capability flags → hasVision/supportsTools; model_info → contextWindow). Reasoning table: off→`think:false`, levels→`think:'low'|'medium'|'high'|'max'`. Parameter normalization → `options{}` envelope (`temperature`,`top_p`,`top_k`,`min_p`,`repeat_penalty`,`num_ctx`→`numCtx`,`num_predict`,`seed`,`stop`,`keep_alive`→`keepAlive`). Kill name-substring vision heuristic.
- **openai**: generic Chat Completions driver over shared wire module. Reasoning: `reasoning_effort` (off→`minimal`). Parameters top-level. No discovery (bare `/v1/models` IDs acceptable later — optional minimal impl returning IDs only is fine).
- **openrouter**: thin shell reusing openai-family wire lib; `discoverModels` hits `/api/v1/models` (context_length, pricing ignored this round, supported_parameters informs nothing dynamic yet); reasoning → `body.reasoning={effort}`; keep bespoke require_parameters retry.
- **anthropic**: SSE-less request/response adapter unchanged mechanically; thinking budget now computed from `maxOutputTokens` metadata fractions (low≈10%, high≈50%, capped) — full switch in Phase 5; supplies `hasVision:true` via discovery stub (static list).
- **echo**: trivial driver wrapping existing mock; test-only.

  2.3 Each driver: `parameterSchema` static export + unit tests for normalization tables and reasoning mappings.

## Phase 3 — Broker cutover + migration module (the big flip)

_Files: `plugins/llm/index.ts` (rewrite), new `src/runtime/provider-migration.ts`, `runtime/conversation-service.ts` (fallback removal), `drone-core/src/capabilities.ts` (capability shape evolves)_

3.1 Migration module (self-contained, deletable):

- Input: merged config. If `providers` absent/empty AND legacy sections exist → synthesize entries named exactly `ollama`, `openai`, `anthropic`, `openrouter` from them (host/baseUrl/apiKey/models[]→models map with localId keys, hasVision passthrough, contextWindow passthrough).
- Seed `llm.active` from legacy `llm.provider`+section defaultModel/model (e.g. `ollama`+`llama3.1` → `"ollama/llama3.1"`). Never overwrite an existing `llm.active`.
- Emit one-time deprecation notice (notice event kind) listing migrated sections. Idempotent: running against already-migrated config is a no-op. Unit-test: every legacy shape, seeding, idempotency, interaction with beacon-injected legacy sections.

  3.2 Broker rewrite:

- Read `config.providers` (post-migration view), resolve drivers via offered capabilities, `createProvider()` per entry. Wrap each created provider: broker-enriched `chat()` fills additive fields (effective parameters after Phase 5; resolved metadata; reasoning per chain) before delegating — single interception point, wire contract intact.
- Activation: `llm.active` parse (first-slash split) → activate matching provider; fallback = first provider; late driver arrivals handled as today. `listModels()` returns merged declared ⊕ discovered (TTL cache ~60s; failure → declared-only + notice). `hasVision`/context-window queries resolve through the metadata chain.
- Budget cache key in conversation-service (`:622–627`) → `` `${activeProviderId}/${currentModel}` ``.
- Remove cross-wired reasoning fallbacks (`conversation-service.ts:646–652`): chain becomes session > model entry > `llm.reasoningLevel` only.
- Capability surface (`DroneLlmCapability`): swap `getModel/setModel` strings for full-form identity; keep method names where possible to limit blast radius; LSP find-references sweep ALL consumers + test mocks.

  3.3 End-of-phase gate: existing user configs produce identical behavior end-to-end (mock-fetch e2e test comparing request payloads pre/post migration for ollama + one cloud provider), EXCEPT documented anthropic delta which lands Phase 5.

## Phase 4 — Selection UX

_Files: `plugins/llm/index.ts` (slash commands), `cli.ts`, `tui/status-bar` (display), new small `selection-identity` util (drone-core)_

4.1 Util: `parseModelSelection('p/rest/of/model') → {providerId:'p', modelLocalId:'rest/of/model'}`, `formatModelSelection`, strict config-form validation vs lenient interactive form.
4.2 `/model` rewrite: bare = read-only browse (merged list w/ provider grouping); `/model <full|bare>` selects: persist `llm.active` to USER-scope config + onSelect stub write when policy applies and model undeclared&undiscovered-persisted-yet; `--once` flag performs neither write. Status bar shows `<provider>/<model>`.
4.3 Consume `--model <provider/model>`: thread `options.modelOverride` (currently dead at `cli.ts:120–122`) into invocation-scoped `llm.active` override before loop start; never persisted.
4.4 Tests: parse edge cases (multi-slash OpenRouter IDs), persistence on/off paths, stub-write policy truth table, flag override.

## Phase 5 — Parameters end-to-end

_Files: broker enrichment wrapper (from 3.2), all four drivers, `shared/openai-compatible.ts`_

5.1 Resolution: `provider.parameters ⊕ model.parameters` shallow (model wins per-key); aliased entries inherit base entry params first (own > base). Enriched chat request carries result.
5.2 Drivers apply normalization into native payloads; unknown-but-schema-absent keys → warning event, still sent; `extra:{}` merged silently. Anthropic: `max_tokens` ← `maxOutputTokens` (driver default when absent — pick sensible default, e.g. 8192); thinking budgets = calibrated fractions OF maxOutputTokens; `session.responseReserveTokens` returns to pure budgeting duty. This is the ONE intended behavior change — call it out in the PR body.
5.3 Tests: precedence matrix (provider-only, model-only, both, alias-inherited), typo-warning emission, extra passthrough, per-driver payload snapshots including num_ctx reaching ollama `options`.

## Phase 6 — Secrets & swarm/scope policy

_Files: `runtime/config.ts` (post-merge pipeline), `config-schema.ts`, swarm docs_

6.1 After FULL merge (defaults→user→project→beacon→coordinator underlays): interpolate `${VAR}` across provider config values; unresolved → validation error naming var + provider path. Literal-key detection: project-scope file contributing a plaintext `apiKey` → loud warning. Project-scope `providers` presence → startup error (carve-out: none needed for legacy since those aren't `providers`).
6.2 Docs: swarm plugin doc section stating LLM sections are valid underlay content + interpolation runs receiver-side. Tests: interpolation success/failure, scope warnings/errors, injected-provider + local-env resolution.

## Phase 7 — Cleanup & docs

7.1 Rewire stragglers to new format ONLY: `plugins/persona/wizard.ts:337` (reads `ctx.config.ollama.model`), `plugins/bootstrap/index.ts:321,347,400,460,527` (writes ollama-flavored picks).
7.2 Delete dead code: legacy section _reads_ outside migration module, ollama vision heuristic remnants, dead `--model` stub, superseded types (`DroneOpenRouterModelConfig.hasVision` etc.), unused imports. Legacy TYPES stay (migration input) until deletion release — mark `@deprecated` pointing at migration module.
7.3 Docs: new `docs/agents/provider-model-config.md` (concepts: providers, protocols, models, aliases, parameters, autoImport, secrets, scopes); update AGENTS.md config-section list + wiki pages later per convention.
7.4 Full LSP find-references sweep over `DroneLlmProvider`, `DroneLlmProviderRegistration`, `DroneLlmCapability`, driver interface + grep cross-check, INCLUDING test mocks (per project principle).

## Execution notes for coding agents

- After ANY drone-core edit: `pnpm -r run build` BEFORE trusting dependent-package LSP (deps resolve from dist/).
- Root commands: `pnpm lint`, `pnpm build`, `pnpm test` (fast suite). Integration suite not required for this plan.
- One commit per phase minimum; tree green before every commit; `.drone-agent/` memory/plan changes committed alongside (we're on a feature branch).
- File-size discipline: split rather than grow (750-line guideline); migration module MUST stay standalone.
- Prettier reformats on lint — re-read files after running linters before further edits.

## Validation criteria (final step — verify ALL before PR)

1. LSP diagnostics clean workspace-wide.
2. `pnpm -r run build` — all packages, zero errors.
3. Root `pnpm lint` (ESLint+Prettier) zero errors.
4. Fast suite `pnpm test` fully green.
5. Unit coverage exists for: migration (shapes/seeding/idempotency/injected-underlay), validation rules (slash-free IDs, alias-chain warn, project-scope ban, unresolved VAR), resolution logic (param merge, metadata chain, reasoning chain), each driver's normalization+reasoning tables, discovery merge/TTL/failure/policies, selection parsing/persistence/--once/--model.
6. Behavioral: migrated legacy config behaves identically (mock-fetch payload comparison) EXCEPT anthropic max_tokens fix; conversation-service/compaction/MCP summarizer/echo untouched-by-diff (verify via git diff scope).
7. Manual smoke: real chat via migrated local-ollama config; `/model <x>` persists + `--once` doesn't; `numCtx` observable in ollama request (debug log); `--model provider/model` invocation override works.
8. PR opened with phased-commit history; PR body documents the anthropic behavior change + deprecation timeline.
