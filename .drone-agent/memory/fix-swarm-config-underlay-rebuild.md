---
key: fix-swarm-config-underlay-rebuild
tags:
  - plan
  - bugfix
  - swarm
  - config
created: 2026-09-12T19:15:46.824Z
updated: 2026-09-12T19:15:46.824Z
---

# PLAN — Fix swarm config underlay rebuild (clobbers providers/llm) + ${VAR} secret delivery

Status: PLANNED (2026-09-12). Root cause confirmed by commit-level evidence; not yet executed.
Branch: feat/coordinator-config-ui-and-secure-storage (Plan B work). Bugs shipped in B4 (6611473) + B5 (8c4b9df); B6/B8 tests missed all three defects below.

## Root cause (verified)

1. PRIMARY — B5 `config` plugin `rebuild()` (drone-agent/src/plugins/config/index.ts ~L475): recomputes `createDefaultAgentConfig()` + registered injectors ONLY, then mutates the shared engine config in place (`shared.providers/llm/compaction/session`). NO disk-config injector exists (only ever-registered injector = BeaconConfigInjector, swarm/index.ts:254), so after the swarm `onSessionStart` hook runs, shared `config.providers`={} and `llm.active`/`llm.modelRoles` revert to bare defaults.
   - Chat survives (broker captured instances + active selection at onPluginsLoaded, pre-rebuild); bare `/model` lists nothing (buildModelListing() re-reads shared providers at call time; 60s discovery cache warmed pre-rebuild masks it briefly); `/context` falls to `source: config` (metadata dead → probe/fallback). Also nukes `session.retry/guardrail` and `compaction` to defaults.
2. LATENT — BeaconConfigInjector.inject() (swarm/config.ts) returns FLAT dotted keys (`'llm.active'`, `'providers.openrouter'`); deepMerge has no dotted-key semantics → garbage top-level keys. B8 rebuild() test passed only because fake injectors returned nested shapes.
3. DESIGN DEFECT — coordinator maskSecretValue (routes/config.ts) masks `apiKey`/`*Key` JSON fields AND scalars, so `${VAR}` templates become `••••VAR}` (docstring claims templates are preserved); beacon persists masked values verbatim as swarm rows; agent underlay path has no receiver-side `${VAR}` interpolation (only the disk-file loader interpolates). Coordinator-pushed secret provider entries can never deliver a working key as designed.

Host evidence: live beacon DB (~/.drone-beacon/drone-beacon.db) still pre-B4 schema, 0 config rows → injector returns {} → only defect 1 manifests here. User config: llm.active, providers.ollama.protocol, providers.openrouter.{protocol,baseUrl,apiKey}, llm.modelRoles.image_describer; no declared models.

## Steps

1. (coder) drone-agent/src/plugins/swarm/config.ts — BeaconConfigInjector.inject(): normalize flat dotted keys into nested PartialDroneAgentConfig. Snippet: build nested object via `deepSet`-style walk (config plugin's helpers.deepSet is the existing dotted-key writer; extract a `deepGetPath`-style setter into drone-core or reuse). Keys not in KNOWN_CONFIG_KEYS → skip + logger.warn once.
2. (coder) drone-agent/src/plugins/config/index.ts — rebuild(): seed from re-resolved disk layers instead of bare defaults: `let rebuilt = mergeLayers(await discoverLayers());` then apply injectors ascending. Update jsdoc ("disk config wins over underlay" now actually true). Keep shared-object in-place mutation (providers/llm/compaction/session) — consumers read at call time.
3. (coder) drone-coordinator/src/routes/config.ts — maskSecretValue(): only mask when value is NOT a `${VAR}` template (`/^\$\{[^}]+\}$/.test(trimmed)` → return verbatim); keep nested apiKey/*Key masking for non-template strings.
4. (coder, optional but recommended) beacon rows + agent underlay: document that secret provider entries must be delivered as `${VAR}` templates; receiver-side interpolation for underlay-provided provider values is OUT of scope (disk loader already interpolates for disk files; underlay values arrive pre-interpolated only if the beacon stores raw templates — step 3 restores that property).
5. (coder) swarm/hooks.ts onSessionStart — keep rebuild() call; it now preserves disk config. No change needed beyond comment accuracy.
6. (tester) Tests — fix the B8 test's producer-shape contract: add a rebuild() test with a BeaconConfigInjector-shaped FLAT payload asserting nested resolution AND disk-config preservation (llm.active from user config survives; providers from disk survive). Add maskSecretValue unit tests: `${VAR}` scalar preserved; `${VAR}` inside provider JSON apiKey preserved; plain scalar masked; nested apiKey masked. Add config-schema-style test that inject() output passes through transformEnvVars-equivalent (or explicitly assert no interpolation, per step 4 decision).
7. (reviewer) Cross-cutting sweep: any other consumer of `applyAgentConfigLayer` receiving flat maps (grep `applyAgentConfigLayer(`); verify drone-core `DroneConfigInjector.inject` jsdoc documents nested-shape contract; run `pnpm -r run build` (drone-core + drone-swarm-common dist staleness bit us at the merge).

## Dependencies

1 → 2 (injector shape must be fixed before rebuild seeding makes underlay meaningful); 3 independent; 6 after 1-3; 7 last.

## Validation criteria

- LSP clean (after `pnpm --filter drone-core run build && pnpm --filter drone-swarm-common run build` + `pnpm -r run build`).
- `pnpm -r run lint` (ESLint + Prettier) zero errors.
- `pnpm -r run test` fast suite green, including the new regression tests (flat-payload rebuild, disk-config preservation, maskSecretValue template preservation).
- Manual smoke: session with swarm connected → `/model` lists ollama + openrouter models; `/context` shows source: metadata/provider (not config); `config.get providers.openrouter` still shows disk values after onSessionStart.