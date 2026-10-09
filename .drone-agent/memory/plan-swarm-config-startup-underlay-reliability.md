---
key: plan-swarm-config-startup-underlay-reliability
tags:
  - plan
  - swarm
  - config
  - llm
  - adr-241
  - executed
created: 2026-10-09T22:23:10.875Z
updated: 2026-10-09T22:41:25.974Z
---

# Plan: Swarm config underlay — startup reliability & broker reactivity (ADR 241)

Branch: `feat/swarm-config-startup-underlay` (cut from main @ 93de525, clean).
Executor persona: code. Red-first per step where noted. Commit at end after memories/insights (per AGENTS.md).

## WHY

Coordinator-distributed provider config (coordinator → beacon underlay → agent `rebuild()`) is unreliable in two ways: (1) the coordinator accepts non-JSON `providers.*` values (a trailing-comma bug shipped silently to every agent, where each agent dropped the row with a one-time-per-process log warning — provider vanished); (2) the llm broker never reacts when the underlay lands at session start: the discovery cache was warmed pre-underlay in `onPluginsLoaded`, so `/model` serves a stale listing for ≤60s (TTL), and a swarm-distributed `llm.active` is NEVER applied because `maybeAutoActivate()` only runs in `onPluginsLoaded`. Verified live: waiting 60s made openrouter models appear. Goal: swarm-configured models are reliable and immediate at session start.

## VERIFIED FACTS (do not re-derive)

- Startup order `drone-agent/src/index.tsx:~377`: `engine.initialize()` → `runHooks('onPluginsLoaded')` (swarm reloadFromBeacon; llm maybeAutoActivate + discovery warm) → `runHooks('onSessionStart')` (swarm hook calls `configCap.rebuild()`, mutating shared config in place) → host mount. The wait already exists; broker just doesn't react.
- Hook order = registration order; `createSwarmPlugin` appends AFTER `staticBuiltInPlugins` (`drone-agent/src/plugins/index.ts`) → an llm `onSessionStart` hook would run BEFORE the swarm rebuild. Self-positioning impossible → reactive event chosen.
- Merge is CORRECT: `providers` in `CONFIG_MERGE_SPEC` `merge` list — per-key merge, whole-entry replace per scope (`drone-core/src/config-types.ts:529`). No overwrite bug.
- `rebuild()` re-applies disk layers and mutates `shared.providers/llm/compaction/session` in place (`drone-agent/src/plugins/config/index.ts:~476-510`). `enablePlugin`/`addExternalPlugin` re-run `onSessionStart` catch-up (`plugin-engine.ts:550,573`) → `rebuild()` can fire mid-session → change handler must be idempotent (fingerprint guard).
- `invalidateDiscovery()` exists at `llm/index.ts:~452`; llm plugin currently never calls `registration.request('config')`.
- Coordinator `PUT /config/:key` (`drone-coordinator/src/routes/config.ts`) does NOT parse `providers.*` values. Agent `BeaconConfigInjector.inject()` (`drone-agent/src/plugins/swarm/config.ts`) drops unparseable rows with a one-time-per-instance warning.
- Out of scope (locked): beacon-freshness re-pull request (nudge + boot sync + 5-min floor stay); `BeaconConfigInjector` fetch timeout hardening.

## LOCKED DESIGN DECISIONS (user-confirmed)

- Q1 scope = Core reactivity (A) + coordinator save-time JSON validation (B) + minimal visibility (C): enrich the existing swarm session-start log line (provider names, declared model counts, resolved llm.active, underlay row recency). No new UI/fragments.
- Q2 mechanism = new OPTIONAL `DroneConfigCapability.onLayersChanged(cb) → unsubscribe`; config plugin fires callbacks at end of `rebuild()`; llm subscribes at register time (config plugin precedes llm in `staticBuiltInPlugins`, so the capability is available). Fingerprint guard = JSON of providers entries + `llm.active` string vs last-seen; identical → zero-churn no-op. NEVER log the fingerprint string (it embeds resolved API keys); log only provider-id diffs.
- Q3 activation rules in `reactToConfigChange()`: (1) no manual selection yet this session → auto-activate resolved `llm.active` if it differs (unresolvable → existing fallback chain + existing warn); (2) manual selection made (`/model` or `--model` override) → never auto-switch; one notice `swarm underlay sets llm.active to X — current selection kept`; (3) active provider vanished from config → keep cached instance (no eviction, chat continuity), warn once. `manualSelection` flag set ONLY by capability `setModel`/`activateProvider` (user-driven), never by auto-activation.
- Q4 = react-in-place: handler is sync (fingerprint → invalidateDiscovery → reactivation) + fire-and-forget `void buildModelListing().catch(noop)` re-warm. Session start never blocks on OpenRouter discovery; immediate `/model` computes on demand.
- Q5 = out of scope (above); observability only: enriched log includes underlay row `updatedAt` recency.

## STEPS (executed as written; see EXECUTION SUMMARY below)

### Step 1 — drone-core: optional `onLayersChanged` on `DroneConfigCapability` [DONE]

### Step 2 — config plugin: registry + fire in rebuild() [DONE]

### Step 3 — llm broker: subscribe + fingerprint + react [DONE]

### Step 4 — coordinator: save-time JSON validation [DONE]

### Step 5 — swarm: enriched session-start log + injector recency [DONE]

### Step 6 — ADR 241 + docs [DONE]

### Step 7 — validation sweep [DONE]

## EXECUTION SUMMARY (2026-10-09, code persona) — PLAN COMPLETE

Branch `feat/swarm-config-startup-underlay`. All steps executed and validated.

- **Step 1**: optional `onLayersChanged?: (cb) => () => void` added to `DroneConfigCapability` (`drone-core/src/capabilities.ts`); drone-core built before dependents. Only test reference was the real capability (no mock sweep needed).
- **Step 2**: per-registration `layerChangeCallbacks` closure + `fireLayerChangeCallbacks()` (try/catch per callback, warn non-fatal) fired at the END of `rebuild()` after the shared mutation; capability `onLayersChanged` register/unregister. 3 tests added to `test/config-plugin.test.ts` (`onLayersChanged` describe: fires-after-mutation, unsubscribe, throwing-subscriber isolation). 27/27 green.
- **Step 3**: llm broker — `configFingerprint()` = `JSON.stringify({p: providers, a: llm.active ?? null})`; subscribe-time baseline pre-underlay; `handleConfigChange()` (equal → return; else provider-id-diff notice, `invalidateDiscovery()`, `reactToConfigChange()`, fire-and-forget `buildModelListing()` re-warm); `reactToConfigChange()` implements the three Q3 rules with `manualSelection` set only in capability `setModel`/`activateProvider`; startup fallback loop extracted into shared `activateFromConfig(logWhenNone)`. NEW `test/llm-underlay-reactivity.test.ts` (7 tests: stale-listing invalidation, auto-activate underlay pin, manual-selection kept + single notice, vanished-provider continuity, no-op silence, unsubscribe). **EN-ROUTE FIX**: the plugin engine THROWS on `registration.request('config')` when the id is undeclared — real-engine suites (beancounter) caught `Plugin llm requested undeclared capability config`; fixed by adding `dependencies: [{ id: 'config', optional: true }]` to the llm plugin metadata. Regression suites green (57 tests across 6 llm files).
- **Step 4**: coordinator `PUT /config/:key` rejects a `providers.*` value that is not a JSON object (400 `must be a JSON object: <parse error>`); empty-string sentinel exempt; non-provider keys untouched. 5 new tests in `drone-coordinator/test/routes/config.test.ts` (valid object, trailing comma 400 + not stored, array 400, llm.active unvalidated, secret sentinel preserved). 29/29 green.
- **Step 5**: `BeaconConfigInjector.getLastAppliedEntries()` (raw rows of last successful fetch, `updatedAt`-filtered, preserved on fetch failure) + enriched single session-start log line (providers + declared model counts, resolved `llm.active`, `underlay rows fetched Ns ago (M rows)`). 2 new tests in `test/swarm/config-injector.test.ts`. 16/16 green.
- **Step 6**: `docs/adr/241-swarm-config-underlay-reactivity.md` (context, D1 onLayersChanged, D2 fingerprint, D3 activation rules, D4 save-time validation, D5 visibility, D6 out-of-scope) + index row appended + `docs/agents/swarm-plugin.md` new "Underlay reactivity (ADR 241)" section replacing the stale "no live mid-session re-apply" sentence.
- **Step 7**: `pnpm -r run build` zero errors (all 8 packages); `pnpm lint` exit 0 (prettier reformatted in place); LSP diagnostics clean; fast suite **3794 passed / 0 failed / 14 skipped** (3808).
- Manual smoke handed to user (plan Step 7 item 5): verify `/model` lists openrouter immediately at session start with the swarm pin, and that the coordinator UI now rejects a trailing-comma providers value with the 400 message.
- Insights logged: persona `code` (engine dependency-declaration gate on `registration.request`), persona `plan` (probe-first diagnosis + discriminating user experiments).

## OUT OF SCOPE (explicit, unchanged)

Beacon-freshness agent→beacon re-pull request; BeaconConfigInjector fetch timeout; full-C TUI notice/fragment; mid-session live re-apply of non-underlay config; legacy `secret:true` row behavior changes.
