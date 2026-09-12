---
key: seed-receiver-side-env-var-interpolation
tags:
  - seed
  - plan-kickoff
  - swarm
  - config
  - secrets
created: 2026-09-12T19:21:23.686Z
updated: 2026-09-12T19:21:23.686Z
---

# SEED — Receiver-side ${VAR} interpolation for swarm config underlay (kickoff context)

Status: SEED for a future planning session. Do not treat as a plan. Prerequisite: land `fix-swarm-config-underlay-rebuild` FIRST — its step 4 (coordinator maskSecretValue preserves `${VAR}` templates) is a hard dependency; without it, masked garbage ('••••KEY}') reaches this path.

## What this feature is

Plan B distributes config coordinator → beacon → agent as an underlay applied at agent session start. Secrets are stored as raw `${VAR}` templates end-to-end (coordinator + beacon never hold the real secret); the RECEIVER (agent) interpolates them from its own process env at apply time. The disk-file config path already does this; the underlay path does not (today underlay values are used verbatim). Goal: make underlay-provided provider entries with template keys actually work, without breaking the write-only secret-edit UI contract.

## Facts already verified (2026-09-12, branch feat/coordinator-config-ui-and-secure-storage)

- Interpolation today lives ONLY in the disk loader: `transformEnvVars` (drone-core/src/config-schema.ts ~L368), called via `parseConfigWithSchema`. Semantics: regex `\$\{([A-Za-z0-9_]+)\}` — bare identifier names only, no `${VAR:-default}` syntax; recursive over strings/arrays/objects; **THROWS on unset env var** with source+keyPath in the message.
- `runtime/provider-migration.ts` has an isTemplate check: `value.trimStart().startsWith('${')` — reuse for template detection (the fix plan's step 4 uses a stricter full-string regex `/^\$\{[^}]+\}$/`; decide one canonical definition).
- Underlay data path: coordinator `GET /api/config` (masks secret reads; UI edits are write-only via keep-current sentinel) → beacon `replaceSwarmConfig` (scope='swarm' rows, composite PK) → `BeaconConfigInjector.inject()` (fetch beacon GET /config merged view, flat dotted keys — fix plan step 3 nests them) → config plugin `rebuild()` (fix plan step 2 seeds from disk layers, then injectors ascending) → in-place mutation of shared engine config.
- Config cascade intent (AGENTS.md): coordinator values ride the beacon underlay at precedence 75, under agent disk config (local wins per key).
- Wiki reference page: swarm page `drone-agent-coordinator-config-pipeline-planB-execution` (B1–B6 surface + Q8 decision: single beacon underlay, no coordinator injector).

## Open design questions for the planning session

1. Where to interpolate: inside `BeaconConfigInjector.inject()` (beacon injector only) vs. generically for ALL injectors inside `rebuild()`? Generic is more future-proof but changes the injector contract (drone-core `DroneConfigInjector.inject` docs + any future injector).
2. Failure semantics: `transformEnvVars` THROWS on unset var. On the underlay path that must not kill session start. Options: per-entry skip + logger.warn (entry omitted), placeholder-preserving + warn (broker fails later at call time with a clear message), or hard error. Recommend: skip-entry + one-time warn, so a single unresolvable key does not blank out the whole `providers.<id>` entry (UNDERLAY_ALLOWLIST allows whole-unit provider entries).
3. Scope of interpolation: whole underlay value vs. only `secret:true` entries vs. only apiKey-like fields. Note nested JSON provider entries have apiKey inside the JSON value string — walk needed either way. Reuse `transformEnvVars` (it already walks nested structures) but wrap the throw into skip-entry semantics.
4. Which process env: the agent's env — but agents are spawned three ways (beacon spawn, coordinator UI spawn panel, gateway spawnBackend). Verify each spawn path passes the user env through (drone-swarm-common spawner) — if any strips env, interpolation silently fails there. NOT yet verified; check before planning.
5. Masked-display contract: coordinator read endpoints must keep masking REAL secrets but show raw `${VAR}` templates verbatim (fix plan step 4). UI keep-current sentinel must keep preserving templates on edit. Interpolation must happen only receiver-side, never server-side (whole point: secret never transits swarm).
6. Timing semantics: underlay applies at session start only (5-min beacon pull + next session). Env var changes therefore take effect on next session restart — document, don't fight it.

## Pointers for the next session

- Files: drone-core/src/config-schema.ts (transformEnvVars), drone-core/src/provider-config-types.ts (`${VAR}` template types), drone-agent/src/runtime/provider-migration.ts + provider-scope-policy.ts (template detection + scope policy interplay), drone-agent/src/plugins/swarm/config.ts (injector), drone-agent/src/plugins/config/index.ts (rebuild), drone-beacon/src/db/config.ts + routes/config.ts, drone-coordinator/src/routes/config.ts (maskSecretValue), drone-coordinator-ui/src/pages/config.tsx (write-only sentinel).
- Plan B memory: plan-coordinator-config-ui-and-secret-handling. Fix plan memory: fix-swarm-config-underlay-rebuild.
- Insights already logged: deepMerge has no dotted-key semantics; maskSecretValue masks templates despite docstring (both in project insights 2026-09-12).