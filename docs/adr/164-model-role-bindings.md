---
tags: [decision, llm, providers, model-roles, config, compaction]
related:
  [
    decisions/155-provider-model-config.md,
    decisions/160-unified-llm-error-retry-semantics.md,
    concepts/provider-model-selection.md,
    concepts/vision-support.md,
    modules/drone-core.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
    entities/DroneAgentConfig.md,
    flows/tool-call-loop.md,
  ]
---

# 164: Model Role Bindings (`llm.modelRoles`)

**Status**: Implemented (2026-08-26, branch `feat/model-role-bindings`, commits `cf3a269`..`42229b8`); **merged to `main`** 2026-08-29 via PR #76 (squash merge `c476a93`, which also carried the sibling feature branches' work: ADRs 160/165/166/167/168)

## Context

Several built-in plugins make their **own** LLM calls rather than riding the main chat loop:

- **compaction** — summarization of oldest turns (a "summarizer" workload)
- **persona wizard** (`persona.create`) — drafting a persona `.md` from a description
- **MCP server-descriptions** — generating a ≤3-sentence purpose summary of a server's tool list

Before this feature, all three reused the session's **single active selection** (`llm.active`). There was no way to route a _specific purpose_ to a different — typically cheaper or differently-provisioned — provider/model. This was a known gap flagged as "per-role model bindings" (à la Continue roles / Aider main+weak) in the provider/model config refactor backlog.

The core challenge: a role pointing at a _different provider_ than the session's active one cannot just swap the model string on the existing active provider's `chat()` — it needs a **different provider instance**, and only the broker knows how to hand one out (with the same parameter/metadata enrichment as the active provider).

## Decision

### 1. Central `llm.modelRoles` config (not per-plugin keys)

A single `llm.modelRoles: Record<string, string>` on `DroneLlmConfig`, mapping a **role name** to a canonical `<providerId>/<modelLocalId>` selection. Centralizing avoids three ad-hoc conventions and matches the existing `llm.active` mental model.

- Values are strict full-form selections (same `^[^/]+/.+` schema pattern as `llm.active`; bare ids rejected) — D2.
- The role namespace is **open**, with a documented well-known set exported from drone-core: `['summarizer', 'wizard', 'describer']` (`WELL_KNOWN_MODEL_ROLES` + `DroneModelRole` type) — D3.
- Startup post-merge validation (`validateModelRoles`) **warns** (never fatal) on role values referencing a nonexistent provider, and on role names outside the well-known list (typo catch: a misspelled `summarizer` would otherwise silently fall back) — D4.
- `modelRoles` merges **per-key** across config layers (user `{summarizer}` + beacon underlay `{wizard}` combine), unlike providers' whole-entry replacement.

### 2. Broker capability `resolveModelForRole(role)`

`DroneLlmCapability` gains `resolveModelForRole(role) → DroneResolvedModelRole` (`{ provider, providerId, model, reasoningLevel? }`):

- **Stateless** — never mutates the active selection and emits no events (D6). `activeProviderId`/`currentModel` are untouched.
- **Fallback-to-active** — unset/unknown/broken roles return the active selection with a **warn-once-per-role-per-session** log (D6). An info-once log fires when a role resolves _differently_ from active.
- The resolved provider is **broker-enriched** exactly like the active one (`enrichProvider` was extracted from `getActiveProvider` and shared) — so role-bound chat calls get effective parameters, resolved context window, and `DroneLlmError.providerId` tagging for free.
- **Reasoning level**: `reasoningLevel` comes from a shared pure helper `resolveConfiguredReasoningLevel(config, selection)` = selected model entry `.reasoningLevel` → `config.llm.reasoningLevel` (no session tier for role calls). The conversation service adopted the same helper for its main-loop reasoning chain (keeping its session-override tier ahead), so per-model reasoning config behaves consistently whether a model is active or role-bound (D12).

### 3. Compaction `summarizer` (flagship consumer)

Compaction drops its startup-wired `getModel`/`getProvider` deps and instead requests the `llm` capability, resolving `'summarizer'` **fresh each compaction round**:

- The resolved role pair drives both the summary **chat call** and its **context-window probe** (so an 8k local summarizer sizes the transcript slice correctly even when the session runs a 1M frontier model) — D7.
- The session's active model still governs compaction **triggering** (usage % vs session window); `getStatus` keeps probing the session model — D7.
- Compaction **started/completed events always name `<providerId>/<model>`** so the transcript is honest about which model did the work — D9.

### 4. Scope policy: project scope banned

`llm.modelRoles` is **banned at project scope** (startup error via `enforceProviderScopePolicy`, same class as `providers`): role values reference providers that may not exist in a freshly-cloned environment. User scope + swarm underlays are sanctioned (D10).

### 5. Config-file editing only for v1

No slash command; `KNOWN_CONFIG_KEYS`/`config.set` does not support dynamic `llm.modelRoles.<role>` paths (same allowlist limitation as `providers.*` — future work) (D11).

## Implementation notes

- **MCP server-descriptions** and the **persona wizard** both migrated onto `resolveModelForRole('describer')` / `resolveModelForRole('wizard')` respectively — the convention applies uniformly to all three internal callers.
- Conversation service adopts `resolveConfiguredReasoningLevel` (behavior-identical refactor).
- `WELL_KNOWN_MODEL_ROLES` intentionally does **not** yet include `image_describer` — that role is a planned follow-up (`plan-image-describer` in project memory).

## Related

- [155-provider-model-config](155-provider-model-config.md) — the provider/model config refactor that established `<providerId>/<modelLocalId>` and the broker
- [160-unified-llm-error-retry-semantics](160-unified-llm-error-retry-semantics.md) — the retry policy role-bound calls ride
- provider-model-selection — selection identity + resolution chains
