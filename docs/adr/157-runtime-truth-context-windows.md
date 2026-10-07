---
tags: [decision, adr, llm, providers, context-window]
related: [156-broker-context-windows-migration-persistence.md, 155-provider-model-config.md, ../concepts/provider-model-selection.md, ../concepts/session-management.md]
---

# 157 — Runtime-truth context windows + discovery metadata enrichment

**Date**: 2026-08-23
**Status**: Accepted (implemented on `feat/provider-model-config`, commits `10d2feb`..`b103095`)

## Context

Decision 156 made the *broker chain* correct, but the data feeding it still
had two holes, and one of its own features didn't work in practice.

1. **OpenAI-family discovery threw metadata away.** `discoverModels()` mapped
   `{ id }` only, yet OpenRouter's `/models` payload carries
   `context_length`, `top_provider.max_completion_tokens` (nullable), and
   `architecture.input_modalities`. Every undeclared model therefore
   collapsed to the 32768 session fallback — the exact symptom users
   describe as "detection doesn't work; only config overrides work."

2. **Ollama reported training maxes, not enforcement reality.** For LOCAL
   models, `/api/show`'s `context_length` is the GGUF maximum, but ollama's
   actual window is VRAM-probed per host and load — and over-context
   requests are **rejected with errors**, not silently truncated.
   Over-reporting is therefore the dangerous direction: budgets sized to a
   fantasy 1M build prompts straight into rejection walls. Empirically:
   local `/api/show` responses carry a Modelfile + a `parameters` blob
   (`num_ctx 8192`); cloud models (`*:cloud`) carry neither and their
   advertised length IS the enforced window. `/api/ps` exposes the
   runtime-computed `context_length` for resident models (server field
   newer than the installed client's types).

3. **The trap**: decision 156's chain prefers declared/discovered catalog
   data over the live probe. Discovery was publishing locals' training
   maxes into the catalog — so even a perfect probe would never run for
   them. Fixing the probe without fixing discovery would have shipped dead
   code.

4. **Provenance was invisible.** The once-per-model "Context window for X
   (source: S)" log line lands nowhere durable (session logs are
   transcripts, not logger streams), so the diagnosability goal was
   unmet in practice.

5. **`/model <pick>` persistence was silently broken.** `llm.active` was
   missing from the config plugin's static `KNOWN_CONFIG_KEYS` allowlist;
   `setValue` threw "Unknown config key" and `persistActiveModel` swallowed
   it into a warning. Two independent user sightings ("thought it was my
   config error"); mocked-capability tests never saw it.

## Decision

**Contract (Option A)** — `DroneLlmProvider.getContextWindowInfo` input
gains optional `parameters` + `extra`; the broker forwards merged effective
request values (identical to what the next `chat()` sends). All window
policy stays in the owning driver.
`DroneContextWindowInfo` gains an optional human-readable `detail` slot
provenance; the four-value `source` union is deliberately NOT widened.
Rejected: (B) driver re-reads the providers entry — duplicates the broker's
parameter-resolution chain and is structurally blind to future
session-level knobs; (E) schema-hint short-circuit — fragments policy
across two layers and mutes the driver's warning path.

**Ollama local precedence** (all `source: 'provider'`, distinguished by
`detail`):

```
/api/ps.context_length      (resident truth; catches VRAM clamping; NEVER triggers a load)
  > request num_ctx         (via buildOllamaOptions: parameters.numCtx AND extra.num_ctx)
    > Modelfile num_ctx     (parsed from show.parameters)
      > driver pin 16384    (OLLAMA_LOCAL_NUM_CTX_PIN — plain constant)
```

The pin exists because ollama's own default is unpredictable across hosts
and 4096 cannot run a coding agent workload; when we must guess, we make
what we send identical to what we report — detection exact by
construction. Resolution exceeding the advertised training length warns
once per model (rope scaling makes exceeding legitimate) instead of
clamping. Cloud detection: `:cloud`/`-cloud` suffix OR absence of both
Modelfile and parameters artifacts; clouds report the advertised length
with `detail: 'advertised (cloud)'`.

**Discovery stops poisoning the catalog**: `discoverOllamaModels` publishes
`contextWindow` for cloud models only. Capability flags are unchanged for
all models; locals simply show blank windows in listings (accepted — blank
is honest).

**OpenRouter-style enrichment**: shared openai-family driver gains
`mapDiscoveredModel` — take-if-present extraction of `contextWindow`
(context_length), `maxOutputTokens` (max_completion_tokens, nullable),
`hasVision` (input_modalities includes 'image'). Vanilla OpenAI's bare-id
responses degrade to id-only entries exactly as before; LM Studio/vLLM/
LiteLLM gateways benefit equally.

**`/context` slash command**: prints model identity, resolved window +
source (+ driver detail slot), response reserve, and estimated usage.
Replaces the invisible log line as the provenance surface; doubles as the
acceptance tool for window-resolution changes.

**Allowlist fix**: `llm.active` and `llm.reasoningLevel` join
`KNOWN_CONFIG_KEYS`; regression test drives the REAL setValue write path
(homedir redirected via doMock — including the default-export override,
because the plugin uses `import os from 'node:os'`). Dynamic
`providers.<id>.models.<key>` paths remain unsupported by design (recorded
as the autoImport blocker).

## Consequences

- Status bar, safety trimming, compaction, and `/context` all inherit
  runtime-truth windows through the single enriched-provider interception
  point — including automatic probe-parameter forwarding, which compaction
  and the budget service get for free.
- Numbers become load-state dependent early in an ollama session (pin
  before first load, enforcement truth after). The direction of correction
  is conservative: under-reporting wastes headroom, over-reporting breaks
  conversations.
- `autoImport` remains inert; docs corrected to factual current-state per
  the code-is-source-of-truth rule. Stub persistence lives on the backlog
  with its root blocker documented.
- Process lessons recorded: parallel same-file patches race (last-writer-
  wins silent revert); ESM default imports dodge namespace-only doMock
  factories; the full-workspace build gate catches type errors that
  vitest/esbuild transforms never surface.

## Validation

Build/typecheck/lint clean workspace-wide; fast suite **2186 passed /
0 failed** (+35 units across four files); zero stale exact-args probe
assertions after the sweep. Manual TUI acceptance (declared vs. undeclared
openrouter, cloud vs. local ollama, `/model` persistence) deferred to the
user.

## Related

- [156-broker-context-windows-migration-persistence](156-broker-context-windows-migration-persistence.md) — parent chain this completes
- [155-provider-model-config](155-provider-model-config.md) — the refactor whose discovery/metadata plumbing this fills in
- provider-model-selection — the metadata chain reference
- session-management — consumers of the corrected denominator
