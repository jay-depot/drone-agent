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
status: completed
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

## COMPLETED (executed 2026-09-10, branch feat/plugin-beancounter)

All 8 steps executed; every validation criterion met. Commits on the branch:
078520f (plan + insight), 19a8928 (core types + drivers + broker ledger),
a0ec724 (beancounter plugin), aff3435 (generalized widget discovery),
51b38bc (tests), plus the final validation/lint commit.
PR: https://github.com/jay-depot/drone-agent/pull/104

What landed:

- drone-core: `DroneLlmUsage` + `usage?:` on `DroneChatResponse`, shared
  `toDroneLlmUsage` normalizer (missing-count guards centralized — drivers
  pass provider-shaped numbers, the helper drops non-finite/negatives and
  synthesizes total), `DroneLlmUsageLedgerEntry` + `getUsageLedger()` on
  `DroneLlmCapability`, `sendUsageInclude` on `DroneProviderConfig` +
  `DroneProviderSchema` + index re-exports.
- Drivers: usage mapping in `fromOpenAiResponse` (openai+openrouter, incl.
  cost/cached/reasoning details), `fromAnthropicResponse`
  (input/output_tokens), ollama `normalized` (prompt_eval_count/eval_count);
  openrouter passes `providerConfig.sendUsageInclude` into
  `createOpenAiProvider` → `body.usage = { include: true }` when set.
- Broker: `usage-ledger.ts` module (extracted per the file-size rule —
  llm/index.ts was already past the threshold) with `record/clear/getAll`
  (readonly view); `enrichProvider(instance, role?)` records post-success;
  role tags 'main' (getActiveProvider) / role name (activeFallback +
  resolveModelForRoleImpl — fallback calls still count toward the role) /
  'image_describer' (all four describer paths); reset via onSessionClear.
- beancounter plugin (opt-in, depends on llm — engine registers
  dependencies first via topo-sort, so `request('llm')` succeeds at
  register time): offers widget {id:'beancounter', label:'USED'}.
- TUI: discovery iterates `engine.listPlugins()` (enabled filter) with a
  shared `isMidPanelWidget` shape guard used by MidPanel too; dead
  `DroneTuiCapability` (incl. never-called `registerMidPanelWidget`)
  removed from tui/types.ts.
- Tests: 5 new groups (toDroneLlmUsage unit, schema valve, per-provider
  mapping incl. absent-usage, ledger accumulate/tag/reset/skip, widget
  formatting incl. 999/1k/1M boundaries, TUI discovery incl. disabled
  exclusion) + `getUsageLedger: () => []` added to 14 stale capability
  mocks (found via the LSP error list after the interface change — the
  sweep principle paid off exactly as documented). tui.test.tsx gained a
  shared `makeEngine` helper replacing three duplicated inline engine
  mocks.

Validation: `pnpm -r run build` 0 errors; `pnpm lint` clean; full fast
suite 2914 passed / 14 skipped (207 files); workspace LSP diagnostics
clean. Manual OpenRouter smoke deferred to the user (optional per plan).
