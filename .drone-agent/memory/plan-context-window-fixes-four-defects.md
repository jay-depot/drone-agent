---
key: plan-context-window-fixes-four-defects
tags:
  - plan
  - completed
  - llm
  - providers
  - context-window
created: 2026-08-23T20:15:26.549Z
updated: 2026-08-23T21:45:27.007Z
---

# PLAN: Context-window detection fixes — four defects (2026-08-23, COMPLETED)

Branch: `feat/provider-model-config` (executed in place; was already a feature branch). Companion memories: `context-window-detection-findings` (evidence), `llm-provider-future-work` (deferred items).

## Execution summary (2026-08-23, all 8 phases done)

**Commits (chronological):**
- `10d2feb` feat(llm): Phase 1+2 — probe contract widening + broker forwarding
- `6bde0b2` feat(ollama): Phase 3 — runtime-truth context windows for local models
- `edf7847` feat(openai-family): Phase 4 — take-if-present discovery enrichment
- `eb9ef16` feat(llm): Phase 5 — /context slash command
- `d526fac` fix(config): Phase 6 — llm.active/llm.reasoningLevel allowlist fix
- `0d6076b` docs(providers): Phase 7 — autoImport inert-status, /context, ollama resolution
- `b103095` chore: lint formatting + DroneSlashCommandContext.conversation gains optional getEstimatedContextUsagePercent

**What landed:**
1. Contract: getContextWindowInfo input gained optional parameters/extra; DroneContextWindowInfo gained optional detail. Source union NOT widened.
2. Broker forwards mergeEffectiveParameters + provider extra into probes (mirrors next chat() exactly).
3. Ollama local precedence: /api/ps.context_length (resident truth via client.ps(), never triggers load) > request num_ctx (buildOllamaOptions so parameters.numCtx AND extra.num_ctx work) > Modelfile num_ctx > pin 16384. Cloud (:cloud/-cloud suffix OR no modelfile+parameters) keeps advertised length with detail 'advertised (cloud)'. Warn-once when resolution exceeds advertised training length. Discovery publishes catalog contextWindow for CLOUD models only (A5-trap regression test pins this).
4. mapDiscoveredModel: take-if-present extraction of context_length/max_completion_tokens(nullable)/image-modality from OpenAI-compatible /models payloads.
5. /context command (context-command.ts): model identity, window+source+detail slot, response reserve, estimated usage %; graceful no-provider path.
6. KNOWN_CONFIG_KEYS += llm.active, llm.reasoningLevel — fixes silently-broken /model persistence. Regression test drives REAL setValue write path (homedir doMock incl. default-export override).
7. Docs corrected to autoImport inert-status factual; wiki synced.

**Validation gate results:** pnpm -r build ✅ 0 errors (caught one real type error vitest/esbuild missed → fixed) · pnpm typecheck ✅ · LSP errors ✅ 0 · root pnpm run lint ✅ clean · fast suite ✅ **2186 passed / 0 failed** / 9 skipped · exact-args sweep ✅ zero remaining.

**Deviations from plan (all justified):**
- Plan said provider-types.ts holds DroneContextWindowInfo; it actually lives in session-types.ts (probe signature is in provider-types.ts) — both edited.
- Gate caught missing conversation-subset accessor; added optional getEstimatedContextUsagePercent to DroneSlashCommandContext.conversation in drone-core/plugin-system.ts.
- createProvider passes registration.logger through (as planned); fetchPsContextLength uses client.ps() (lib exposes it; its ModelResponse type lacks the server's new context_length field → defensive access).

**Remaining (user-assisted manual acceptance, per plan Phase 8.7):** fresh TUI session → /context on declared openrouter model (metadata), undeclared discovered openrouter model (metadata w/ enriched window), ollama cloud ('advertised (cloud)'), ollama local unconstrained ('driver pin 16384'), and /model <pick> persisting without swallowed warning. Status bar sanity on fresh sessions.

## Original locked decisions (preserved for reference)
Option A contract widening; local precedence chain as above; cloud := !modelfile && !parameters || :cloud/-cloud suffix; detail field not source union; discovery cloud-only publishing; take-if-present OpenRouter enrichment; autoImport punted (backlog Soon #5) with docs inert-status; provenance via /context; out of scope: secrets storage, status-bar warn-tint, ps telemetry.