---
key: plan-beancounter-usage-cost-widget
tags:
  - plan
  - beancounter
  - llm
  - usage
  - cost
  - openrouter
  - tui
  - mid-panel
created: 2026-09-10T22:35:22.987Z
updated: 2026-09-10T22:35:22.987Z
---

Plan: `beancounter` — session token & cost mid-bar widget (planned 2026-09-10, all requirements confirmed by user)

## Summary
Opt-in plugin (`beancounter`, defaultEnabled:false) showing one mid-bar line `USED: 45.2k tok · $0.0421` — cumulative provider-reported token usage + cost for the session. Real-time cost management, not budget tracking. Data collection lives in the always-on llm broker (in-memory ledger); beancounter is consumer+renderer.

## Locked decisions
1. All providers map usage into additive `usage?: DroneLlmUsage` on DroneChatResponse (openai+openrouter via fromOpenAiResponse; anthropic input_tokens/output_tokens; ollama prompt_eval_count/eval_count). Missing cost = 0.
2. Ledger in broker enrichProvider (llm/index.ts:117-153) — the single chokepoint covering main rounds, model roles (summarizer/wizard), image_describer, describeImages. Physical calls counted individually; OpenRouter tool-routing retry is ONE chat() (final response only → no double count). Role tags: 'main' / role name / 'image_describer' via enrichProvider(instance, role?) signature.
3. Display: `USED: <tokens> tok · $<cost>` single line (toFixed(4) cost; tokens k/M format), hidden when ledger empty (getContent → []).
4. Generalized TUI widget discovery: replace hardcoded knownWidgetPluginIds (app.tsx:200) with engine.listPlugins() iteration + shape guard.
5. Opt-in; in-memory; reset on /clear via broker hooks.onSessionClear; NO reset on compaction; no client-side pricing math.
6. `sendUsageInclude?: boolean` provider-entry valve (DroneProviderConfig + DroneProviderSchema config-schema.ts:90 + createOpenAiProvider options → body.usage={include:true}). Default off — user empirically confirmed usage arrives without it via --debug llm.

## Steps (1→2→3→4/5/6→7→8; run pnpm -r run build after any drone-core edit before LSP in dependents)
1. drone-core: DroneLlmUsage type + usage? on DroneChatResponse (session-types.ts:109); sendUsageInclude on DroneProviderConfig (provider-config-types.ts:53) + DroneProviderSchema (config-schema.ts:90); DroneLlmUsageLedgerEntry {providerId, model, role?, usage, at} + getUsageLedger() on DroneLlmCapability (capabilities.ts:161).
2. Drivers: openai-compatible.ts extend OpenAiUsage (cost, *_details) + map in fromOpenAiResponse (:124); openai-driver.ts sendUsageInclude option + buildBody; openrouter/index.ts passes providerConfig.sendUsageInclude; anthropic-adapter.ts fromAnthropicResponse (:241-284) maps usage; ollama/driver.ts normalized (:445-455) maps SDK prompt_eval_count/eval_count.
3. Broker ledger: enrichProvider records usage entries post-success; role tags at activeFallback/resolveModelForRoleImpl/resolveDescriber; onSessionClear reset; getUsageLedger on capability. MANDATORY find-references sweep: enrichProvider, DroneLlmCapability, DroneChatResponse (implementers/consumers/test mocks).
4. Plugin: drone-agent/src/plugins/beancounter.ts (focus.ts pattern); request 'llm' (declare metadata.dependencies — request throws on undeclared); offer widget {id:'beancounter', label:'USED'}; registerHelp; add to staticBuiltInPlugins (plugins/index.ts).
5. TUI: app.tsx:198-212 listPlugins()-based discovery (enabled filter, mount-time parity); MidPanel getContent guard stays; add belt-and-suspenders widget shape check. Reviewer checkpoint: DroneTuiCapability.registerMidPanelWidget (tui/types.ts:44) is dead code — verify pushColorOverride usage, remove dead parts.
6. Tests (tester): (a) usage mapping ×3 providers + undefined guards; (b) sendUsageInclude body test; (c) ledger accumulate/role-tag/reset/skip-absent via stub protocol driver; (d) widget formatting boundaries + empty-hidden; (e) TUI renders widget from non-hardcoded id, disabled excluded. Echo-llm fixture (docker/echo-llm:85) emits 3-field usage. Ink tests: poll for content, no fixed-tick barriers.
7. Review (reviewer): readonly ledger views, no pricing math, dead code, llm/index.ts at 1021 lines — extract ledger if split threshold crossed.

## Validation criteria
- LSP zero errors+warnings on touched files; pnpm -r run build after drone-core edits before trusting dependents' LSP
- pnpm -r run lint + pnpm -r run build zero errors; re-read files after prettier
- pnpm -r run test green; all 5 new test groups present
- Shared-interface sweep completed (DroneChatResponse, DroneLlmCapability, enrichProvider)
- Optional manual smoke: real OpenRouter key + --debug llm → usage.cost in raw response → ledger → mid-bar; /clear resets

Key file:line anchors: DroneChatResponse session-types.ts:109; fromOpenAiResponse openai-compatible.ts:124; enrichProvider llm/index.ts:117-153; describeImagesImpl llm/index.ts:327 (drops usage — must emit at enrichProvider); knownWidgetPluginIds app.tsx:200; MidPanelWidget tui/types.ts:21; emitEvent/dispatch plugin-engine.ts:403-411,634-638; DroneConversationEvent session-types.ts:175-232 (closed union, 18 kinds); AnthropicChatResponse usage anthropic-adapter.ts:91; ollama normalized driver.ts:445-455; echo-llm usage docker/echo-llm/src/index.ts:85.