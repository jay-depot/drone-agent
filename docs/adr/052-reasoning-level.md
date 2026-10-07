---
tags: [decision, llm, config, providers]
related: [concepts/reasoning-level.md, decisions/003-broker-provider.md]
---

# Decision 052: Reasoning Level Control

**Status**: Implemented

**Date**: 2026-07-08

## Context

LLM providers are adding reasoning/thinking controls with different parameter names, locations, and value vocabularies. Anthropic uses `effort` (low/medium/high/xhigh/max), OpenAI uses `reasoning.effort` (none/minimal/low/medium/high/xhigh), Ollama uses `think` (boolean or low/medium/high/max). We needed a unified user-facing control that works across all providers.

## Decision

### 1. Normalized enum: `off | low | medium | high | max`

A 5-value scale that maps cleanly to all providers. We intentionally excluded `xhigh` and `minimal` from the normalized enum — those are provider-specific and can be accessed via `--raw`.

### 2. `off` degrades gracefully on always-thinking models

Models like Anthropic Fable 5/Mythos 5 and GPT-OSS cannot fully disable thinking. `off` silently degrades to `low` (best-effort) rather than erroring.

### 3. Config at two layers: provider-agnostic + per-provider

- `llm.reasoningLevel` — the general default
- `ollama.reasoningLevel` / `openrouter.reasoningLevel` — provider-specific override

### 4. Session-only by default, user config for persistence

The `/reasoning` command is session-only. No `--save` flag exists (the user can use `/config set llm.reasoningLevel <value> --scope user`).

### 5. Raw pass-through for provider-specific values

The `--raw` flag accepts any string and passes it directly to the provider, bypassing the normalized enum. This covers `xhigh`, `minimal`, and any future provider-specific values.

### 6. Provider interface change

`DroneLlmProvider.chat()` input gains an optional `reasoningLevel` field. Each provider's `chat()` handler maps it to the appropriate wire format.

## Consequences

### Positive

- Single control surface across all providers
- Backward compatible — `undefined` means "use provider default"
- Provider-specific values still accessible via `--raw`
- Simple resolution hierarchy: session > config > default

### Negative

- Provider interface change required touching all provider implementations
- `off` is not perfectly equivalent across providers (always-thinking models can't fully disable)
- No per-model reasoning levels (macros cover this use case)

## Implementation

- **Commit**: `7b5a1c0` — "feat: add reasoning level control across providers"
- **Files**: 11 source files + 15 test files
- **Tests**: typecheck passes, all 1249 tests pass
- **Key types**: `DroneReasoningLevel`, `DroneLlmCapability.{get|set}ReasoningLevel`

## Research

Full provider comparison table in [[concepts/reasoning-level]].