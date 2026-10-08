---
tags: [decision, config, underlay, swarm, secrets, env-vars, bugfix, adr]
related:
  [
    concepts/beacon-config-override-spec.md,
    architecture/config-cascade.md,
    modules/drone-agent-plugins.md,
    modules/drone-core.md,
    modules/drone-coordinator.md,
    modules/drone-beacon.md,
    decisions/212-coordinator-config-pipeline.md,
    decisions/095-config-deep-merge-refactor.md,
    decisions/209-stored-secrets-config-split.md,
  ]
---

# 213: Swarm config underlay — rebuild precedence fix + receiver-side `${VAR}` interpolation

**Status**: Implemented (2026-09-12) · **Branch**: `feat/coordinator-config-ui-and-secure-storage` (`feb18d2`, `fcf246a1`) · **Plans**: project-memory `fix-swarm-config-underlay-rebuild` + `plan-receiver-side-env-var-interpolation` — _both deleted from project memory after ingest_; the seeding memory `seed-receiver-side-env-var-interpolation` is **CONSUMED**

**Summary**: Two coupled defects made the coordinator→beacon→agent underlay from [212-coordinator-config-pipeline](212-coordinator-config-pipeline.md) unsafe to use. First, `rebuild()` recomputed config from defaults + injectors **only**, then mutated the shared engine config **in place** — so after the swarm `onSessionStart` hook ran, `providers` was `{}` and `llm.active`/`modelRoles` were lost. Second, the beacon injector returned **flat dotted keys** (`providers.x`) which `deepMerge` has no semantics for, and the coordinator's `maskSecretValue` **corrupted `${VAR}` templates** (`'${OPENROUTER_API_KEY}'` → `'••••KEY}'`). Separately, the underlay path never performed the env-template interpolation the disk-config path already did, so a pushed `"apiKey": "${OPENROUTER_API_KEY}"` arrived as a literal string. This ADR covers the three fixes plus the receiver-side interpolation feature.

## Context

The three root causes were verified before implementation:

1. **PRIMARY — `rebuild()` clobbers the live config.** `rebuild()` recomputed from `createDefaultAgentConfig()` + registered injectors only (no disk-config injector exists), then mutated the shared engine config object in place. After the swarm `onSessionStart` hook, `providers = {}` and `llm.active`/`modelRoles` were lost. Chat survived only because the broker had captured provider state _before_ the rebuild; a bare `/model` listed nothing (the listing re-reads `providers` at call time through a 60s cache) and `/context` fell back to `source: config`.
2. **LATENT — the injector returned flat dotted keys.** `BeaconConfigInjector.inject()` returned `{ 'providers.x': {...} }`, but `deepMerge` ([decisions/095-config-deep-merge-refactor]]) has no dotted-key semantics. The Plan B test passed only because its **fake** injectors used nested shapes — a test-double shape mismatch that hid the bug.
3. **DESIGN DEFECT — template corruption.** The coordinator's `maskSecretValue` masked `${VAR}` templates (`'${OPENROUTER_API_KEY}'` → `'••••KEY}'`), corrupting the entries the beacon persists and the underlay consumes.

A fourth gap: the disk-file path interpolates `${VAR}` templates from the agent process env at layer parse time (`transformEnvVars` in `drone-core/src/config-schema.ts`), but the **underlay path did not** — templates reached the live config as literal strings, so a coordinator-pushed provider entry could never authenticate.

## Decision

1. **Normalize the injector payload to a nested shape.** New exported `normalizeFlatUnderlay(flat)` nests dotted keys via a prototype-pollution-safe `deepSet` (never throws), filters keys through `isUnderlayAllowed`, and returns `{ config, skippedKeys }`. `inject()` JSON-parses each row (unparseable → dropped, one-time warn per key), normalizes, and caches; the cache-fallback on fetch failure is preserved.
2. **`rebuild()` composes precedence faithfully — disk layers LAST.** `rebuild()` composes default → injectors ascending → disk user/project layers last (the default layer is skipped on re-application). The shared-object in-place mutation is kept (consumers hold references).
3. **`maskScalar` returns whole-value `${VAR}` templates verbatim.** A trimmed value matching `/^\$\{[^}]+\}$/` passes through unmasked; mid-string templates are still masked; nested JSON `apiKey` masking is unchanged.
4. **Receiver-side `${VAR}` interpolation (Q1–Q7 locked).**
   - **Q1 Placement**: injector-local — a pure exported `resolveEnvTemplates(key, value)` in `swarm/config.ts` wrapping `drone-core` `transformEnvVars`. The generic `DroneConfigInjector` contract is unchanged (nested in, nested out).
   - **Q2 Failure**: row-level drop + once-per-key warning; `inject()` never throws. Granularity is the whole entry (provider entries are whole-entry units per the allowlist).
   - **Q3 Scope**: the whole row value is interpolated before normalization, so nested provider JSON is walked automatically.
   - **Q4 Canon**: three `${...}` definitions coexist **by role** — `transformEnvVars` = RESOLUTION, `isVarTemplate` = CLASSIFICATION, `maskScalar` full-string = MASKING. Two documented gaps; no regex unification.
   - **Q6 Timing**: documentation-only — resolution happens at session start, so env changes take effect next session. The injector's cache-fallback returns earlier same-process interpolated values.
   - **Q7 Tests**: three layers, red-first; env set before apply, restored in `afterEach`; fake injectors unregistered; assert output shape, never `expect(...).toThrow()`.

## Implementation

- `drone-agent/src/plugins/swarm/config.ts` — exported `normalizeFlatUnderlay(flat)` and `resolveEnvTemplates(key, value)`; the injector's row loop is now JSON.parse → `isUnderlayAllowed` silent skip → `resolveEnvTemplates` → on failure a once-per-key `Dropping underlay entry "<key>": <reason>` warning + `continue` → `flat[key] = resolved`. A new `warnedUnresolvedKeys` Set sits beside `warnedUnparseableKeys`.
- `drone-agent/src/plugins/config/index.ts` — `rebuild()` precedence corrected (disk layers last).
- `drone-coordinator/src/routes/config.ts` — `maskScalar` whole-value template pass-through.
- `drone-coordinator/src/mask.ts` — `maskScalar`/`maskSecretValue` extraction (later reused by the phase-2 secrets store in [209-stored-secrets-config-split](209-stored-secrets-config-split.md)).
- `drone-agent/src/plugins/swarm/hooks.ts` — `onSessionStart` comment corrected (no phantom injector-at-100).
- `drone-core/src/capabilities.ts` — `DroneConfigInjector.inject` JSDoc now documents the nested-shape contract and that template resolution is each injector's own concern (`applyAgentConfigLayer` does no interpolation).
- `docs/agents/swarm-plugin.md` — masking-preserves-templates semantics stated; the receiver-side interpolation section rewritten to current-state both-paths behavior (row-drop, once-warn, timing, the two gaps, spawn-env asymmetry); a pre-existing garbled sentence repaired.
- `AGENTS.md` — the Config System clause updated.

## Deviations recorded

1. **Underlay key filter is `isUnderlayAllowed` (`UNDERLAY_ALLOWLIST`), not the fix plan's literal `KNOWN_CONFIG_KEYS`.** The plan had a gap: `KNOWN_CONFIG_KEYS` contains no `providers.*` entries and would have silently dropped every coordinator-pushed provider entry, defeating the feature.
2. **`rebuild()` composition is inverted versus the fix plan's literal step-2 snippet.** The snippet (disk first, then injectors) would have let the beacon **win over disk** for shared keys, contradicting the plan's own JSDoc, `AGENTS.md`, and the `DroneConfigInjector` docs. The invariant was implemented and pinned with a test.
3. **`resolveEnvTemplates` passes the initial keyPath.** The interpolation plan's reference snippet called `transformEnvVars(value, 'swarm underlay')` without it, but its own STEP 1 case 4 requires the failure reason to include row-key context. Implemented as `transformEnvVars(value, 'swarm underlay', key)`.
4. **A pre-existing test was reworked in place, not supplemented.** The test asserting literal `${SWARM_KEY}` passthrough asserted exactly the behavior this feature replaces; it became `resolves ${VAR} templates` and failed during the STEP 3 green-run before the rework, as predicted.
5. **`pnpm -r run test` fails at drone-core ("No test files found") on a pristine tree** — pre-existing infra quirk (drone-core has no local vitest config; the root config's includes are workspace-root-relative). The real fast suite is root `pnpm test`.

## Consequences

- The underlay is now **safe**: a session-start rebuild no longer wipes disk providers, so `providers`/`llm.active`/`modelRoles` survive and `/model` lists correctly.
- A coordinator-pushed provider entry with `"apiKey": "${OPENROUTER_API_KEY}"` **actually authenticates** — secrets never transit the swarm in plaintext, and **no server ever holds the real value**.
- Templates survive masking end-to-end (coordinator store → beacon persist → agent apply), closing the corruption path.
- A row referencing an unset variable is **dropped with a one-time warning** rather than silently becoming a literal string.
- This "no server holds a real secret" posture was later **deliberately extended** by [209-stored-secrets-config-split](209-stored-secrets-config-split.md), which added a coordinator-side secrets store so real API keys could be managed in the UI at all.

## Validation

**Red-first evidence captured.** `normalizeFlatUnderlay`/`resolveEnvTemplates` helper tests failed pre-implementation (`TypeError: resolveEnvTemplates is not a function`, 6/6). The E2E Phase A assertion failed pre-fix with `expected '${DRONE_TEST_UNDERLAY_KEY}' to be 'sk-swarm-literal-5678'` and Phase B with `expected {...} to be undefined` (source reverted via `git stash` for the check). The 2 mask unit tests and 2 rebuild precedence tests were red pre-fix and green post-fix.

LSP clean; `pnpm -r run build` exit 0; `pnpm lint` exit 0; fast suite 2992 passed / 14 skipped (fix) and 3003 passed / 14 skipped (interpolation).

Test files: `drone-agent/test/swarm/config-injector.test.ts` (new — 5 fix tests plus `resolveEnvTemplates` unit tests and 4 integration tests), `drone-agent/test/config-plugin.test.ts` (2 E2E phases), plus rebuild/mask additions.

**Pending (handed to the user)**: live manual smoke — beacon + coordinator restarted on the new `dist`; a provider entry with `${VAR}` set via the coordinator UI → a fresh TUI session with the var exported lists the provider in `/model` and authenticates; var unset → entry absent + warning; disk config still wins shared keys.

## Related

- [212-coordinator-config-pipeline](212-coordinator-config-pipeline.md) — the pipeline this repairs
- beacon-config-override-spec — the underlay spec (also corrected by this work)
- [config-cascade](005-config-cascade.md) — the cascade the precedence fix upholds
- [095-config-deep-merge-refactor](095-config-deep-merge-refactor.md) — the merge semantics that made flat dotted keys wrong
- [209-stored-secrets-config-split](209-stored-secrets-config-split.md) — the later secrets model that supersedes the template-only posture
