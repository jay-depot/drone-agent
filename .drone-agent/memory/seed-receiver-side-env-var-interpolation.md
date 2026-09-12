---
key: seed-receiver-side-env-var-interpolation
tags:
  - seed
  - consumed
  - swarm
  - config
  - secrets
created: 2026-09-12T19:21:23.686Z
updated: 2026-09-12T20:37:55.519Z
---

# SEED — Receiver-side ${VAR} interpolation for swarm config underlay (CONSUMED)

Status: CONSUMED 2026-09-12 — planning complete; the design decisions and implementation steps now live in plan memory `plan-receiver-side-env-var-interpolation`. This seed is retained for background context only; do not execute from it.

Original purpose: kickoff context for receiver-side ${VAR} interpolation of swarm config underlay values. Prerequisite fix-swarm-config-underlay-rebuild landed (feb18d2).

## Resolution summary (2026-09-12 grilling session)

1. Placement: injector-local — inside BeaconConfigInjector.inject() via pure helper resolveEnvTemplates (wraps drone-core transformEnvVars); generic injector contract unchanged.
2. Failure: row-level drop + once-per-key warn; inject() never throws (allowlist "whole-entry unit" semantics).
3. Scope: whole-unit interpolation, symmetric with disk path.
4. Template canon: three definitions coexist by role (resolution/classification/masking); document, don't unify.
5. Masked-display contract: verified already intact (maskScalar pass-through + UI write-only keep-current sentinel) — no change.
6. Timing: document-only; resolves at session start.
   Plus: spawn-env audit confirmed all spawn paths pass full parent env to the agent (beacon env for relayed spawns); no sanitization anywhere.

Full plan: project memory plan-receiver-side-env-var-interpolation.
