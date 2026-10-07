---
tags: [llm, usage, cost, tui, mid-panel, widget, adr]
related: [modules/drone-core.md, modules/drone-agent-plugins.md, modules/drone-agent-tui.md, concepts/provider-model-selection.md, decisions/155-provider-model-config.md, decisions/164-model-role-bindings.md, decisions/165-image-describer-role.md]
---

# Beancounter: provider-reported usage + cost mid-bar widget

**Summary**: The LLM broker now captures provider-reported token usage and (where reported) cost for every chat call, threaded end-to-end from each protocol driver through drone-core types into a session-lifetime usage ledger, and a new opt-in `beancounter` plugin renders that ledger as a `USED xxx tok · $0.0042` widget in the TUI mid panel. This is the first consumer of generalized mid-panel widget discovery — the TUI no longer hardcodes which plugins own widgets but discovers them structurally from plugin capabilities.

## Context

drone-agent never tracked how many tokens it consumed or what it cost. The providers already reported usage in their native responses — OpenRouter returns `usage` with `cost` and cached/reasoning itemizations, anthropic returns `input_tokens`/`output_tokens`, ollama returns `prompt_eval_count`/`eval_count`, OpenAI-family endpoints return `prompt_tokens`/`completion_tokens`/`total_tokens` — but the drivers discarded that data at the wire boundary (`fromOpenAiResponse`/`fromAnthropicResponse`/the ollama driver built a `DroneChatResponse` without usage). The broker (which enriches and routes every `chat()` call through `enrichProvider`) had no accounting, and the TUI's mid panel (which renders widgets like the todo summary) had a hardcoded widget-capability model that could not consume a plugin-offered widget generically.

## Decision

1. **Normalize provider-reported usage into a shared `DroneLlmUsage` type.** `promptTokens`/`completionTokens`/`totalTokens`, plus provider-optional `cost` (USD), `cachedPromptTokens`, and `reasoningTokens`. Absent fields mean the provider did not report them — consumers must treat a missing `cost` as zero and never estimate pricing client-side. A `toDroneLlmUsage({ prompt, completion, total, cost, cached, reasoning })` normalizer validates each count (finite, non-negative), falls back `total` to `prompt + completion`, and returns `undefined` when neither prompt nor completion is usable so callers can skip recording. It rides additively on `DroneChatResponse.usage?` so every existing provider remains valid without setting it.
2. **Every driver maps native usage → `DroneLlmUsage`.** `fromOpenAiResponse` maps `usage` incl. cost + prompt-token cached details + completion reasoning details; anthropic maps `input_tokens`/`output_tokens`; ollama maps `prompt_eval_count`/`eval_count`; openrouter (OpenAI-family) additionally supports a `sendUsageInclude` provider-config opt-in that sends `usage: { include: true }` in the request body (default false — OpenRouter already returns usage/cost without it, and vanilla OpenAI-compatible endpoints may reject unknown body keys).
3. **The broker records one ledger entry per successful broker-routed chat call at the `enrichProvider` chokepoint.** The ledger tags each entry with `providerId`, `model`, the broker path that produced it (`role` — `'main'` for the active provider, the model-role name, or `'image_describer'`), and a timestamp. Because recording lives in the single interception point shared by the active provider AND every role-resolved provider, every broker-routed call is counted exactly once. The ledger (`createUsageLedger` in a new `plugins/llm/usage-ledger.ts` module) is **reset on session clear** (`onSessionClear`) but **not on compaction** — compaction drops context, not cost. Available via `DroneLlmCapability.getUsageLedger()` returning a readonly view.
4. **New opt-in `beancounter` plugin** (`defaultEnabled: false`, depends on `llm`) offers a mid-panel widget capability (`offer({ id: 'beancounter', label: 'USED', getContent })`) that sums the ledger's `totalTokens` (coarse-scaling `<1000 → N`, `<1M → N.Nk`, else `N.NM`) and `cost ?? 0` into `<tokens> tok · $<cost>` (cost to 4 decimals); returns an empty array (widget hidden) until the first usage entry. It also registers a `/help` line.
5. **Generalize mid-panel widget discovery.** The TUI previously looked for a named hardcoded capability per widget. It now iterates `engine.listPlugins()`, asks each enabled plugin for its own-id capability, and keeps it only if it structurally satisfies `isMidPanelWidget` (`id: string`, `label: string`, `getContent: () => string[]`) — a structural guard so unrelated capabilities are never rendered as widgets. The `MidPanel` component renders each non-empty-sections widget as a `Label: content` fragment separated by `│` pipes, hiding entirely when nothing has content. The dead `DroneTuiCapability` type was removed.

## Implementation

- `drone-core/src/session-types.ts` — `DroneLlmUsage`, `toDroneLlmUsage`, `DroneChatResponse.usage?`
- `drone-core/src/capabilities.ts` — `DroneLlmUsageLedgerEntry`, `DroneLlmCapability.getUsageLedger()`
- `drone-core/src/provider-config-types.ts` + `config-schema.ts` — `sendUsageInclude?: boolean` (type + schema)
- `drone-agent/src/shared/openai-compatible.ts` — `fromOpenAiResponse` maps usage (cost/cached/reasoning)
- `drone-agent/src/plugins/openai/openai-driver.ts` — `createOpenAiProvider` gains the `sendUsageInclude` option (OpenRouter)
- `drone-agent/src/plugins/openrouter/index.ts` — passes `sendUsageInclude` through to the shared driver
- `drone-agent/src/plugins/anthropic/anthropic-adapter.ts` — `fromAnthropicResponse` maps input/output tokens
- `drone-agent/src/plugins/ollama/driver.ts` — maps `prompt_eval_count`/`eval_count`
- `drone-agent/src/plugins/llm/usage-ledger.ts` — `createUsageLedger` (record/clear/getAll)
- `drone-agent/src/plugins/llm/index.ts` — ledger at `enrichProvider`, `getUsageLedger()` on the capability, `onSessionClear` reset
- `drone-agent/src/plugins/beancounter.ts` — the widget plugin (opt-in)
- `drone-agent/src/plugins/index.ts` — registers `beancounterPlugin`
- `drone-agent/src/tui/types.ts` — `MidPanelWidget`, `isMidPanelWidget` guard; `DroneTuiCapability` removed
- `drone-agent/src/tui/app.tsx` — widget discovery via `engine.listPlugins()` + `getCapability`
- `drone-agent/src/tui/components/MidPanel.tsx` — renders sections; hidden when empty

## Tests

- `drone-core/test/llm-usage.test.ts` — `toDroneLlmUsage` normalization (fallback total, absent fields, invalid counts)
- `drone-core/test/providers-config.test.ts` — `sendUsageInclude` type/schema
- `drone-agent/test/openai.test.ts` / `openrouter.test.ts` / `anthropic.test.ts` / `ollama.test.ts` — per-driver usage mapping
- `drone-agent/test/beancounter.test.ts` — widget formatting, hide-until-first-entry, cost handling
- `drone-agent/test/tui.test.tsx` — generalized widget discovery + `isMidPanelWidget` guard

## Key Points

- **Accounting lives at the broker chokepoint, not in each caller.** Recording in `enrichProvider` means every broker-routed call (main rounds, model roles, the image describer) lands in the ledger exactly once, whatever the path.
- **`cost` is OpenRouter-only today and always optional.** The type and widget explicitly never estimate pricing client-side; a missing cost renders as `$0.0000`, not a guess.
- **Clear vs. compaction distinction is deliberate.** `/clear` resets the session bill; compaction (context dropping) intentionally does not — you still pay for what stayed in the window.
- **The ledger is the API surface; the widget is just one consumer.** `getUsageLedger()` is on the `llm` capability, so any plugin (not just beancounter) can read session usage/cost.
- **Widget discovery is structural, not name-pairing.** `isMidPanelWidget` filters every enabled plugin's own-id capability by shape, so new widgets (like beancounter's) are picked up with no TUI changes — the fixture `DroneTuiCapability` that previously coupled TUI to specific widget owners is gone.

## Related

- [drone-core](../../drone-core/) — `DroneLlmUsage`, `DroneLlmUsageLedgerEntry`, capability additions
- [drone-agent-plugins](../../drone-agent/src/plugins/) — llm broker ledger, drivers, beancounter plugin
- [drone-agent-tui](../../drone-agent/src/tui/) — generalized mid-panel widget discovery
- provider-model-selection — the role-tagged ledger entries (`main`/role name/`image_describer`)
- [155-provider-model-config](155-provider-model-config.md) — the broker `enrichProvider` interception point that now also records usage
- [164-model-role-bindings](164-model-role-bindings.md) — model roles whose calls are now ledger-tagged by role
- [165-image-describer-role](165-image-describer-role.md) — the `image_describer` role that is ledger-tagged `'image_describer'`
