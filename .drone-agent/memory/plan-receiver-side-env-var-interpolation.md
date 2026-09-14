---
key: plan-receiver-side-env-var-interpolation
tags:
  - plan
  - swarm
  - config
  - secrets
  - completed
created: 2026-09-12T20:37:55.649Z
updated: 2026-09-12T20:52:45.587Z
---

# PLAN — Receiver-side ${VAR} interpolation for the swarm config underlay

Status: ✅ COMPLETED (executed 2026-09-12). Branch: feat/coordinator-config-ui-and-secure-storage. Prerequisite fix-swarm-config-underlay-rebuild ✅ (feb18d2) was the hard dependency (maskScalar whole-value template pass-through).

## Summary & why

Plan B distributes agent config coordinator → beacon → agent as an underlay applied at session start. Secrets are stored as raw ${VAR} templates end-to-end (no server ever holds the real secret). The disk-file path already interpolates templates from the agent process env at layer parse time (transformEnvVars, drone-core/src/config-schema.ts); the underlay path did not — template values reached the live config as literal strings. This feature makes the agent (receiver) interpolate underlay templates from its own env at apply time, so a coordinator-pushed provider entry with "apiKey": "${OPENROUTER_API_KEY}" actually authenticates. Secrets never transit the swarm in plaintext.

## Locked design decisions (grilling session 2026-09-12)

- Q1 PLACEMENT: injector-local — inside BeaconConfigInjector.inject(), via pure exported helper resolveEnvTemplates in swarm/config.ts wrapping drone-core transformEnvVars. Generic DroneConfigInjector contract unchanged (nested in, nested out).
- Q2 FAILURE: row-level drop + once-per-key warn; inject() never throws. Granularity = whole entry (providers.* are whole-entry units per UNDERLAY_ALLOWLIST).
- Q3 SCOPE: whole unit — transformEnvVars over the entire parsed row value before normalizeFlatUnderlay; nested provider JSON walked automatically.
- Q4 CANON: three ${...} definitions coexist by role — transformEnvVars = RESOLUTION; isVarTemplate = CLASSIFICATION; maskScalar full-string = MASKING. Two documented gaps, no regex unification.
- Q5 MASKED-DISPLAY: closed by verification (maskScalar pass-through + UI write-only keep-current sentinel already preserve templates end-to-end). No change.
- Q6 TIMING: document-only. Resolves at session start; env changes take effect next session (usually next process). inject() cache-fallback returns earlier same-process interpolated values.
- Q7 TESTS: 3 layers, red-first; env set before apply + afterEach restore; unregister fake injectors; assert output shape, never expect throws.

## Execution record (2026-09-12)

Implemented exactly per plan, with three recorded deviations:

1. STEP 2 snippet gap: the plan's reference snippet called transformEnvVars(value, 'swarm underlay') without the initial keyPath — but STEP 1 case 4 requires the failure reason to include row-key context. Implemented as transformEnvVars(value, 'swarm underlay', key), which satisfies case 4 (transformEnvVars prefixes the initial keyPath into its thrown message).
2. STEP 4 Layer 2 case 1: the pre-existing test 'fetches the beacon merged config, nests flat keys, and preserves ${VAR} templates' asserted literal ${SWARM_KEY} passthrough — the exact behavior the feature replaces. It was reworked in place into 'resolves ${VAR} templates' (env set → literal) instead of a purely additive test; the old assertion failed during STEP 3 green-run as predicted before the rework.
3. Validation criterion 5: `pnpm -r run test` fails at drone-core ("No test files found") on a PRISTINE tree — pre-existing infra quirk (drone-core has no local vitest config; the root config's include patterns are workspace-root-relative and don't resolve from inside the package). The project's actual fast suite is root `pnpm test` (single root run): 211 files / 3003 tests passed, 14 pre-existing skips, exit 0. Recorded as environment note, not a regression.

## What shipped

- drone-agent/src/plugins/swarm/config.ts: exported UnderlayResolution type + resolveEnvTemplates(key, value) helper (try/catch over transformEnvVars, whole-row granularity); inject() row loop now JSON.parse → isUnderlayAllowed silent skip → resolveEnvTemplates → on failure once-per-key warn `Dropping underlay entry "<key>": <reason>` + continue → flat[key] = resolved value. New warnedUnresolvedKeys Set (separate from warnedUnparseableKeys). Class jsdoc states current-state receiver-side semantics.
- Tests: 6 helper unit tests (describe('resolveEnvTemplates')), 4 integration tests (resolvable row; unset-var drop + exactly-one warn + no repeat on second inject; non-allowlisted row with template → no resolution warn; fetch failure → cached interpolated config), 2 E2E Phase A/B in config-plugin.test.ts (env set → rebuilt.providers.swarmtest.apiKey === literal + shared engine config mutated + disk provider intact; env unset → swarmtest absent + exactly 1 warn + disk untouched). Real BeaconConfigInjector registered via cap.registerInjector, unregistered in describe-level afterEach (module-level registry).
- Docs: docs/agents/swarm-plugin.md (both stale passages rewritten: interpolation paragraph now receiver-side both-paths with row-drop/once-warn/timing/two gaps/spawn-env asymmetry; also repaired a pre-existing garbled sentence in the underlay paragraph); drone-core/src/capabilities.ts DroneConfigInjector.inject jsdoc line (template resolution is each injector's own concern; applyAgentConfigLayer does no interpolation); AGENTS.md Config System clause.

## Validation status

- Red-first evidence: helper tests failed pre-impl (TypeError: resolveEnvTemplates is not a function, 6/6); E2E Phase A failed pre-fix with expected '${DRONE_TEST_UNDERLAY_KEY}' to be 'sk-swarm-literal-5678' and Phase B with expected {...} to be undefined (source reverted via git stash for the check).
- LSP clean; `pnpm -r run build` exit 0; `pnpm lint` exit 0 (no reformatting); root fast suite `pnpm test` 3003 passed / 14 skipped, exit 0.
- Pending (handed to user): manual live smoke — beacon + coordinator restarted on new dist; provider entry with ${VAR} set via coordinator UI → fresh TUI session with var exported lists the provider in /model and authenticates; var unset → entry absent + warn; disk config still wins shared keys.
