---
key: plan-receiver-side-env-var-interpolation
tags:
  - plan
  - swarm
  - config
  - secrets
created: 2026-09-12T20:37:55.649Z
updated: 2026-09-12T20:37:55.649Z
---

# PLAN — Receiver-side ${VAR} interpolation for the swarm config underlay

Status: READY (planned 2026-09-12). Branch: feat/coordinator-config-ui-and-secure-storage. Prerequisite: fix-swarm-config-underlay-rebuild ✅ COMPLETED (feb18d2) — its maskScalar whole-value template pass-through is the hard dependency and is shipped + test-pinned.

## Summary & why
Plan B distributes agent config coordinator → beacon → agent as an underlay applied at session start. Secrets are stored as raw ${VAR} templates end-to-end (no server ever holds the real secret). The disk-file path already interpolates templates from the agent process env at layer parse time (transformEnvVars, drone-core/src/config-schema.ts); the underlay path does not — template values reach the live config as literal strings today. This feature makes the agent (receiver) interpolate underlay templates from its own env at apply time, so a coordinator-pushed provider entry with "apiKey": "${OPENROUTER_API_KEY}" actually authenticates. Secrets never transit the swarm in plaintext.

Blast radius: drone-agent/src/plugins/swarm/config.ts (+~30 lines), test/swarm/config-injector.test.ts, one E2E in test/config-plugin.test.ts, docs (swarm-plugin.md, capabilities.ts jsdoc line, AGENTS.md clause). NO drone-core / coordinator / UI / spawner changes.

## Locked design decisions (grilling session 2026-09-12)
- Q1 PLACEMENT: injector-local — inside BeaconConfigInjector.inject(), via pure exported helper resolveEnvTemplates in swarm/config.ts wrapping drone-core transformEnvVars. Generic DroneConfigInjector contract unchanged (nested in, nested out). Mirrors disk per-layer parse-time interpolation.
- Q2 FAILURE: row-level drop + once-per-key warn; inject() never throws. Granularity = whole entry, matching UNDERLAY_ALLOWLIST doc ("providers.* — treated as a whole-entry unit", drone-core/src/config-keys.ts:96-104). Rejected: placeholder-preserving (opaque late 401), hard error (kills session start), per-field skip (half-resolved units).
- Q3 SCOPE: whole unit — transformEnvVars over the entire parsed row value before normalizeFlatUnderlay; nested provider JSON (apiKey inside JSON string) walked automatically; symmetric with disk path. No secret-flag threading.
- Q4 CANON: three ${...} definitions coexist by role — transformEnvVars = canonical RESOLUTION (mid-string, bare identifiers, throws on unset); isVarTemplate (provider-migration.ts) = CLASSIFICATION; maskScalar full-string /^\$\{[^}]+\}$/ = MASKING. Document roles + 2 gaps; no regex unification.
- Q5 MASKED-DISPLAY: closed by verification — maskScalar pass-through + UI write-only keep-current sentinel (drone-coordinator-ui/src/pages/config.test.tsx:176) already preserve templates end-to-end. No change.
- Q6 TIMING: document-only. Resolves at session start; env changes take effect next session (usually next process). Note inject() cache-fallback returns values interpolated in an earlier same-process session. Doc line: "set the env var before launching the agent."
- Q7 TESTS: 3 layers, red-first; env set before apply + afterEach restore; unregister fake injectors (module-level registry leak, B8 lesson); assert output shape (row absent + warn count), never expect throws.

## Verified groundwork (this session)
- Spawn audit (subagent): ALL paths ENV-REACHES-AGENT. Shared spawner drone-swarm-common/src/spawner.ts:155-162 spreads process.env + additive config.env override. No sanitization/denylist/dotenv anywhere in repo. Asymmetry to document: coordinator-relayed spawns see the BEACON host's env, not the coordinator's/gateway's (CoordinatorSpawnBackend).
- rebuild() (drone-agent/src/plugins/config/index.ts:481-509): default seed → injectors ascending → disk user/project LAST → in-place shared mutation. Interpolation belongs inside inject(), pre-merge. No changes needed in the config plugin.
- inject() today: fetch → per-row JSON.parse (once-warn via warnedUnparseableKeys + injectable warn callback) → normalizeFlatUnderlay (isUnderlayAllowed filter + deepSet) → cache; fetch failure → cachedConfig.
- Underlay allowlist is narrow (drone-core/src/config-keys.ts:96): providers.*, llm.active, llm.reasoningLevel, compaction.enabled, compaction.strategy, session.guardrail.*.

## Steps

STEP 0 — Baseline: clean tree on feature branch; run test/swarm/config-injector.test.ts + test/config-plugin.test.ts, record green baseline.

STEP 1 — RED: helper unit tests in test/swarm/config-injector.test.ts, new describe('resolveEnvTemplates'). Use DRONE_TEST_UNDERLAY_KEY; set before affected tests, delete in afterEach (env must be set before apply — interpolation runs at layer apply). Cases: (1) deep object with "${DRONE_TEST_UNDERLAY_KEY}" → resolved literal; (2) mid-string template resolved; (3) unset var → { ok:false }, reason names the var; (4) reason includes row-key context; (5) non-template strings byte-identical; (6) numbers/booleans/null passthrough, nested arrays walked. Verify each fails pre-implementation for the predicted reason (helper missing).

STEP 2 — GREEN: implement in drone-agent/src/plugins/swarm/config.ts:
```ts
import { transformEnvVars } from 'drone-core';

export type UnderlayResolution =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export function resolveEnvTemplates(key: string, value: unknown): UnderlayResolution {
  try {
    return { ok: true, value: transformEnvVars(value, 'swarm underlay') };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
```
jsdoc: receiver-side resolution of ${VAR} templates in one underlay row — counterpart of the disk loader's parse-time interpolation; failure granularity is the whole row (provider entries are whole-entry units; a half-resolved provider that lists but cannot authenticate is worse than an honest absence).

STEP 3 — GREEN: wire into inject() row loop, order: JSON.parse (existing once-warn unchanged) → isUnderlayAllowed(entry.key) skip silently (normalizeFlatUnderlay re-checks; pre-skip stops resolution warns on keys that would be dropped anyway) → resolveEnvTemplates → on !ok: once-per-key warn `Dropping underlay entry "<key>": <reason>` + continue → else flat[key] = resolved.value. Add a SECOND once-set warnedUnresolvedKeys (separate from warnedUnparseableKeys so a row fixed of one failure kind can still warn on the next). Update class jsdoc: replace the "receiver-side interpolation is a documented follow-up" sentence with current-state semantics (resolves whole-value and mid-string templates receiver-side from process.env at apply time; unset var drops the row with a once-per-key warn).

STEP 4 — RED→GREEN integration + E2E:
- Layer 2 (test/swarm/config-injector.test.ts, mocked fetch — stub { ok:true, json: async () => entries } and assert fetch called; inject() swallows fetch errors, so a bad stub must not fake a pass): (1) resolvable row → resolved value returned; (2) unset-var row dropped + exactly one warn naming var + key; second inject() → no repeat warn; (3) non-allowed row with template → skipped, no resolution warn; (4) fetch failure → cached (interpolated) config returned.
- Layer 3 (test/config-plugin.test.ts, existing 'rebuild underlay + disk preservation' block): real BeaconConfigInjector + stubbed fetch, registered via cap.registerInjector and UNREGISTERED in afterEach. Phase A: env set → rebuilt.providers.swarmtest.apiKey === literal. Phase B: NEW injector instance + fresh stub, env deleted → swarmtest absent from rebuilt.providers; disk-config provider untouched.

STEP 5 — Docs (current-state factual, no aspirational language):
- docs/agents/swarm-plugin.md: rewrite the interpolation paragraph — receiver-side resolution at session start from the agent process env; row-level drop + once-per-key warn; timing ("set the env var before launching the agent; changes take effect next session"); two known gaps: non-identifier var names (${FOO-BAR}) are unresolvable and stay literal (same-as-disk rule), and mid-string templates inside secret:true entries cannot round-trip the write-only sentinel contract — secrets must be whole-value ${VAR} to survive; beacon-env asymmetry (relayed spawns see beacon host env).
- drone-core/src/capabilities.ts: one informational line on DroneConfigInjector.inject jsdoc — template resolution is each injector's own concern (beacon injector resolves against the agent process env). Contract unchanged.
- AGENTS.md Config System section: one clause — underlay ${VAR} templates are resolved receiver-side at session apply time.

STEP 6 — Full validation (see criteria).

STEP 7 — Close out: plan memory → COMPLETED (+ deviations); seed memory marked consumed; insights logged; commit everything including .drone-agent/ files (feature branch, per AGENTS.md).

## Validation criteria
1. Red-first evidence: every new test verified failing pre-change for the predicted reason.
2. LSP diagnostics clean across the workspace.
3. pnpm -r run build exit 0.
4. pnpm lint (workspace ESLint + Prettier) exit 0; if Prettier reformats, re-read files before further edits.
5. Fast suite pnpm -r run test fully green incl. the two touched suites (~12 new tests).
6. Docs match shipped behavior; no aspirational leftovers.
7. Manual live smoke handed back to user (beacon + coordinator restarted on new dist): provider entry with ${VAR} set via coordinator UI → fresh TUI session with var exported lists the provider in /model and authenticates; var unset → entry absent + warn; disk config still wins shared keys.
8. Plan memory updated to COMPLETED with any recorded deviations.