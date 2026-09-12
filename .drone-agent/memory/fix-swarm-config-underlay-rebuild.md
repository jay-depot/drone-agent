---
key: fix-swarm-config-underlay-rebuild
tags:
  - plan
  - bugfix
  - swarm
  - config
  - completed
created: 2026-09-12T19:15:46.824Z
updated: 2026-09-12T20:05:32.456Z
---

# PLAN — Fix swarm config underlay rebuild (clobbers providers/llm) + ${VAR} secret delivery

Status: ✅ COMPLETED (executed 2026-09-12). Branch: feat/coordinator-config-ui-and-secure-storage. Automated validation green: `pnpm -r run build` exit 0, `pnpm lint` (ESLint + Prettier) exit 0, fast suite 211 files / 2992 tests passed (3 pre-existing skips), LSP clean. RED→GREEN confirmed: all new regression tests failed against pre-fix code exactly as predicted, pass post-fix (46/46 across the three touched suites). Manual live smoke (fresh TUI session: `/model`, `/context`) handed back to the user — the beacon on this host was still running the pre-fix build at execution time.

## Root cause (verified pre-execution)

1. PRIMARY — B5 `rebuild()` recomputed from `createDefaultAgentConfig()` + registered injectors ONLY (no disk-config injector exists), then mutated shared engine config in place → after swarm `onSessionStart`, providers={} and llm.active/modelRoles lost. Chat survived (broker captured state pre-rebuild); bare `/model` empty (listing re-reads providers at call time, 60s stale cache); `/context` → source:config.
2. LATENT — `BeaconConfigInjector.inject()` returned FLAT dotted keys; `deepMerge` has no dotted-key semantics. B8 test passed only because fake injectors used nested shapes.
3. DESIGN DEFECT — coordinator `maskSecretValue` masked `${VAR}` templates ('${OPENROUTER_API_KEY}' → '••••KEY}'), corrupting entries the beacon persists and the underlay consumes.

## What shipped (per step)

- Fix 1 (injector shape): drone-agent/src/plugins/swarm/config.ts — exported `normalizeFlatUnderlay(flat)`: nests dotted keys via `deepSet` (prototype-pollution-safe, never throws), filters keys with `isUnderlayAllowed`, returns `{config, skippedKeys}`. `inject()` JSON.parses per row (unparseable → dropped, one-time warn per key via injectable `warn` callback wired from swarm/index.ts to registration.logger.warn), normalizes, caches; cache-fallback on fetch failure preserved. New test file drone-agent/test/swarm/config-injector.test.ts (5 tests).
- Fix 2 (rebuild, precedence-faithful — DEVIATION): config/index.ts rebuild() composes default → injectors ascending → disk user/project layers LAST (default layer skipped on re-application). The plan's literal snippet (disk first, then injectors) would have let the beacon WIN over disk for shared keys, contradicting the plan's own jsdoc, AGENTS.md cascade, and DroneConfigInjector docs — implemented the invariant, pinned it with a test. Shared-object in-place mutation kept.
- Fix 3: drone-coordinator/src/routes/config.ts — maskScalar returns raw verbatim for whole-value `${VAR}` templates (/^\$\{[^}]+\}$/ on trimmed); mid-string templates still masked; nested JSON apiKey masking unchanged; docstrings now factual.
- Steps 4+5: swarm/hooks.ts onSessionStart comment corrected (no phantom injector-at-100); docs/agents/swarm-plugin.md rewritten to current-state: masking preserves whole-value templates, receiver-side interpolation of underlay values explicitly NOT yet implemented (documented follow-up → memory seed-receiver-side-env-var-interpolation).
- Step 6 tests: 2 rebuild disk-preservation/precedence tests + B8-fake unregister cleanup (module-level registry leakage); 6 maskSecretValue unit tests. All red pre-fix, green post-fix.
- Step 7 sweep: 3 applyAgentConfigLayer consumers total (rebuild ×2, startup loader, provenance merge) — no other flat-map producers; drone-core DroneConfigInjector.inject jsdoc now documents the nested-shape contract (drone-core/src/capabilities.ts).

## Deviations from plan (recorded)

1. Underlay key filter = `isUnderlayAllowed` (UNDERLAY_ALLOWLIST) instead of the plan's KNOWN_CONFIG_KEYS — plan gap: KNOWN_CONFIG_KEYS has no `providers.*` entries and would have silently dropped coordinator-pushed provider entries, defeating the feature.
2. rebuild() composition inverted vs. the plan's literal step-2 snippet, to honor the plan's own "most local wins" invariant (test-pinned).

## Validation status

- LSP clean; `pnpm -r run build` exit 0; `pnpm lint` exit 0; fast suite 2992 passed / 14 skipped (pre-existing skips), exit 0.
- Pending: manual live smoke on a restarted agent session (beacon + coordinator must be restarted to pick up rebuilt dist).
