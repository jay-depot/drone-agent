---
key: plan-swarm-config-startup-underlay-reliability
tags:
  - plan
  - swarm
  - config
  - llm
  - adr-241
created: 2026-10-09T22:23:10.875Z
updated: 2026-10-09T22:23:10.875Z
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

## STEPS (execute in order; single executor)

### Step 1 — drone-core: optional `onLayersChanged` on `DroneConfigCapability` [coder]
File: `drone-core/src/capabilities.ts` (`DroneConfigCapability`, ~line 123). Add optional field:
```ts
/** Subscribe to config-layer changes. Fires after every rebuild() whose
 *  result differs from the previous rebuild; returns an unsubscribe fn. */
onLayersChanged?: (cb: () => void) => () => void;
```
Optional → additive; no implementer sweep required, but grep test mocks for `DroneConfigCapability` to confirm none break typecheck. Then `pnpm --filter drone-core run build` BEFORE touching dependent packages (they resolve types from built dist/, per project principle).

### Step 2 — config plugin: registry + fire in rebuild() [coder]
File: `drone-agent/src/plugins/config/index.ts`. Inside `register()` closure (NOT module scope — prior session hit a module-level injector-registry leak): `const layerChangeCallbacks: Array<() => void> = [];`
Capability addition:
```ts
onLayersChanged: cb => {
  layerChangeCallbacks.push(cb);
  return () => {
    const i = layerChangeCallbacks.indexOf(cb);
    if (i !== -1) layerChangeCallbacks.splice(i, 1);
  };
},
```
At the END of `rebuild()` (after shared mutation), fire each callback in its own try/catch, logging non-fatal errors (`registration.logger.warn`).
RED-first tests in `drone-agent/test/config-plugin.test.ts` (extend existing `DroneConfigCapability` describe): fires on rebuild, unsubscribe stops firing, throwing callback is non-fatal, no fire when nothing changed is NOT this step's concern (fingerprint lives in the llm subscriber, not the config plugin).

### Step 3 — llm broker: subscribe + fingerprint + react [coder]
File: `drone-agent/src/plugins/llm/index.ts`.
(a) In `register()`: `const configCap = registration.request<DroneConfigCapability>('config'); if (configCap?.onLayersChanged) configCap.onLayersChanged(handleConfigChange);` (absent capability → current behavior unchanged).
(b) `function configFingerprint(): string` — reads `registration.getConfig()`, returns `JSON.stringify({ p: config.providers, a: config.llm?.active ?? null })`. Baseline captured at subscribe time (pre-underlay).
(c) `handleConfigChange()`: compute fp; if equal to `lastFingerprint` return; store; then `invalidateDiscovery()` (sync), `reactToConfigChange()` (sync), `void buildModelListing().catch(() => {})` (re-warm). Log a one-line diff: `LLM config changed: providers added [x] removed [y]` (ids only).
(d) `reactToConfigChange()` per Q3 rules. State: `let manualSelection = false;` set true in capability `setModel()` and `activateProvider()` only. Reuse `activateFull()`, `getInstance()`, existing fallback loop from `maybeAutoActivate()`.
(e) Extract the fallback loop from `maybeAutoActivate()` into a shared helper if needed to avoid duplication (project rule: ruthless about duplicated code).
RED-first tests in NEW `drone-agent/test/llm-underlay-reactivity.test.ts` (mock-registration pattern from `test/llm-provider-switching.test.ts` + `test/openrouter.test.ts`; echo or fake driver):
1. config change invalidates stale listing (listing reflects new provider immediately on next buildModelListing)
2. underlay llm.active auto-activates when no manual selection
3. manual `/model` selection kept + one notice when llm.active differs
4. vanished active provider kept (instance still resolvable) + warn once
5. identical rebuild (same fingerprint) → no invalidation, no logs
6. unsubscribe stops reactivity

### Step 4 — coordinator: save-time JSON validation [coder]
File: `drone-coordinator/src/routes/config.ts`, PUT handler, after the allowlist check and BEFORE write-only sentinel logic; only when `typeof value === 'string' && key.startsWith('providers.')`:
```ts
let parsed: unknown;
try { parsed = JSON.parse(value); } catch (err) { parsed = err; }
if (parsed instanceof Error || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  return reply.code(400).send({ error: `Config key "${key}" must be a JSON object: ${parsed instanceof Error ? parsed.message : 'value is not a JSON object'}` });
}
```
UI needs no change — the add/edit dialog already surfaces 400s via `extractApiError`.
RED-first tests in `drone-coordinator/test/routes/config.test.ts`: valid JSON 200; trailing comma → 400 with message; JSON array → 400; non-providers keys unaffected; write-only secret sentinel path unaffected.

### Step 5 — swarm: enriched session-start log + injector recency [coder]
File `drone-agent/src/plugins/swarm/config.ts`: add `getLastAppliedEntries(): Array<{ key: string; updatedAt: number }>` to `BeaconConfigInjector` (records the raw rows from the last successful fetch; empty when none).
File `drone-agent/src/plugins/swarm/hooks.ts` (`onSessionStart`, ~line 300): after `rebuild()`, replace the current log line with one enriched line, e.g.:
`Swarm config underlay applied: providers: openrouter (12 models), ollama (1); llm.active: openrouter/x; underlay rows fetched 12s ago`
(provider names + declared model counts from `rebuilt.providers`; `llm.active` resolved value; newest row age from the injector; omit provider/row parts gracefully when absent). Keep single info line. Tests: extend `drone-agent/test/swarm/config-injector.test.ts` for `getLastAppliedEntries`; hooks logging covered by injector test + manual smoke.

### Step 6 — ADR 241 + docs [coder]
- NEW `docs/adr/241-swarm-config-underlay-reactivity.md`: context (60s stale listing; swarm llm.active ignored; silent unparseable-row drop; trailing-comma incident), decisions (Q1–Q5 above, all spelled out), consequences (mid-session enablePlugin rebuilds now reactive; secrets never logged via fingerprint; beacon freshness unchanged).
- Append row to `docs/adr/index.md`.
- Update `docs/agents/swarm-plugin.md` config section: replace the "no live mid-session re-apply" sentence with: underlay applies at session start via `rebuild()`; the llm broker reacts immediately (listing + activation); mid-session plugin-enabling catch-up also applies + reacts; ordinary mid-session config changes still wait for the next session start.

### Step 7 — validation sweep [reviewer/tester]
1. `pnpm --filter drone-core run build` then `pnpm -r run build` — zero errors
2. `pnpm lint` — zero (prettier will reformat; re-read files after)
3. LSP diagnostics — clean across drone-core, drone-agent, drone-coordinator
4. `pnpm test` (fast suite) — green; new tests enumerated in steps 2–4 green
5. Manual smoke (user): with valid coordinator `providers.openrouter` + `llm.active` pin → start agent → `/model` lists openrouter immediately, active selection honored; save a trailing-comma value → coordinator UI shows the 400 error message.

## VALIDATION CRITERIA (plan-complete when ALL hold)
- LSP clean (no exceptions); `pnpm lint` and `pnpm -r run build` zero errors; fast test suite green.
- All new tests pass: config-plugin (onLayersChanged ×4), llm-underlay-reactivity (×6), coordinator config route (×5), swarm config-injector (getLastAppliedEntries).
- No behavior change when swarm plugin/config capability absent (local-only agents).
- Secrets never appear in any log line (fingerprint value never logged; enriched line names providers only).
- ADR 241 + index + swarm-plugin.md updated; branch committed with .drone-agent artifacts per AGENTS.md.

## OUT OF SCOPE (explicit)
Beacon-freshness agent→beacon re-pull request; BeaconConfigInjector fetch timeout; full-C TUI notice/fragment; mid-session live re-apply of non-underlay config; legacy `secret:true` row behavior changes.