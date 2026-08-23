---
key: plan-provider-model-config
tags:
  - plan
  - llm
  - providers
  - refactor
  - completed
created: 2026-08-23T00:35:15.967Z
updated: 2026-08-23T02:46:03.425Z
---

# Plan: Provider/Protocol/Model Config Refactor — ✅ COMPLETED 2026-08-23

**Branch:** `feat/provider-model-config` (from main@96b68dd; backlog commit 061cf5d). **Status: EXECUTED IN FULL — all 7 phases + all 8 validation criteria verified.** One commit per phase, tree green at every commit.

## What was built (phase → commit)
1. **Phase 1** "feat(providers): Phase 1" — drone-core: provider-config-types.ts (DroneProviderConfig/DroneModelEntryConfig with one-level aliasing, DiscoveredModel, LlmParameterSchema, LlmProtocolDriver), model-selection.ts (parse/format/validate `<providerId>/<modelLocalId>`, first-slash split), DroneChatRequest extracted from inline chat() input with additive parameters/extra/maxOutputTokens/hasVision, config.providers map + llm.active, merge spec entry-level replace for providers, validateProviders semantic rules. 23 tests.
2. **Phase 2** "feat(providers): Phase 2" — drivers: plugins/ollama/driver.ts (SDK logic, /api/tags+/api/show discovery w/ capability flags→hasVision/supportsTools, camelCase→options{} envelope; vision name-heuristic killed), openai/openai-driver.ts shared by openrouter (reasoning_effort off→minimal, /models discovery; openrouter = reasoningInBody + require_parameters retry), anthropic-driver.ts (thinking budgets calibrated fractions of maxOutputTokens), echo driver. DroneLlmCapability.registerDriver() added; legacy registerProvider kept during migration window (@deprecated).
3. **Phase 3** "feat(providers): Phase 3" — runtime/provider-migration.ts (self-contained/deletable; synthesizes ollama/openai/anthropic/openrouter providers when providers empty, seeds llm.active from llm.provider+defaultModel, never overwrites existing active, idempotent); loadAgentConfig runs migration+validateProviders after full merge (errors throw, warnings surfaced on DroneResolvedConfig.warnings[]); broker rewrite (one provider instance per providers entry via registerDriver, activation from llm.active at onPluginsLoaded so partial driver sets can't win the race, listModels declared⊕discovered with 60s TTL + non-fatal failure, metadata chain declared>alias-base>discovered>defaults); conversation-service budgetKey now `${providerId}/${model}`, reasoning chain session>model-entry>llm.reasoningLevel (cross-wired fallbacks dead), setModel accepts full-form selections.
4. **Phase 4** "feat(providers): Phase 4" — --model is a real invocation-scoped override (applied after broker activation via conversation.setModel, never persisted); status bar shows full-form identity; CLI parse tests.
5. **Phase 5** "feat(providers): Phase 5" — broker-enriched chat(): effective params = provider.parameters ⊕ model.parameters (shallow, model wins; aliases inherit base first) + resolved maxOutputTokens/hasVision + provider extra{} passthrough; unknown-vs-schema keys warn-but-send via driver parameterSchema.
6. **Phase 6** "feat(providers): Phase 6" — runtime/provider-scope-policy.ts: project-scope providers = startup ERROR; project-scope plaintext apiKey = loud warning (${VAR} templates fine); user scope + swarm underlays unrestricted; swarm-plugin.md documents underlay contract + receiver-side interpolation.
7. **Phase 7** "feat(providers): Phase 7" — persona wizard + bootstrap + first-run write new format only & probe ollama via driver.discoverModels; zero legacy section reads outside migration module (grep-verified); docs/agents/provider-model-config.md written; AGENTS.md updated.

## Validation results (all 8 criteria)
1. LSP/typecheck clean (tsc -p tsconfig.test.json + pnpm -r typecheck). 2. pnpm -r build green. 3. pnpm lint green. 4. Fast suite 2072 passed / 0 failed (138 files). 5. Coverage: migration(11)+validation(13)+resolution(7)+driver tables(9)+selection parsing(10)+broker switching(7)+--model parse(4)+scope policy(7)+payload-equivalence(3) = 71 new units. 6. Payload equivalence verified (openai byte-identical incl. headers; anthropic identical except documented max_tokens delta; compaction/MCP/mcp-summarizer untouched by diff). 7. Manual smoke vs live local ollama: migrated legacy config chats (notice fired, driver activated, SMOKE-OK round-trip); new-format config with temperature+numCtx chats and wire capture shows options.num_ctx=2048; --model override works (OVERRIDE-OK); /model persist/--once covered by broker suite. 8. PR opened with phased commits + anthropic-delta note.

## Key implementation facts for future work
- Driver delivery mechanism: protocol plugins call llmCap.registerDriver(driver) via existing request('llm') dep — engine offer()/request() has no reverse direction (capabilities.set keyed by plugin id).
- Broker auto-activation deliberately deferred to onPluginsLoaded (registerDriver mid-stream only instantiates instances) to avoid partial driver sets winning the llm.active race.
- transformEnvVars interpolates per-layer at parse time (pre-existing behavior; equivalent to post-merge since env is node-local) — documented in swarm-plugin.md instead of moved.
- Swarm injectors (BeaconConfigInjector.registerInjector) have NO consumer in src — rebuild()/inject() never called anywhere; dormant subsystem, left as-is.
- anthropic wire max_tokens ← resolved maxOutputTokens (driver default 8192); thinking budget low≈10%, others ≈50% OF maxOutputTokens; session.responseReserveTokens back to pure budgeting. This is THE intentional behavior change for the PR body.
- openai-family off-mapping changed none→minimal per locked decision 10.
- Legacy TYPES (DroneOllamaConfig etc.) retained as migration input; legacy reads outside provider-migration.ts are gone.

## Follow-ups (see also memory `llm-provider-future-work`)
- onSelect autoImport stub-writing not yet wired into /model persistence path (policy plumbing exists; stub write is a no-op today).
- PR body must document anthropic max_tokens change + deprecation timeline; delete provider-migration.ts + scope-policy grandfather clauses when window closes.