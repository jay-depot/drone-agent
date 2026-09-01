---
key: plan-web-port-auth-enforcement
tags:
  - plan
  - executed
  - coordinator
  - web-auth
  - drone-swarm
  - bootstrap
  - security
created: 2026-09-01T21:16:27.231Z
updated: 2026-09-01T21:50:44.759Z
---

# Plan: Close the coordinator web-port /api auth gap + give the pipeline a token path

## Status: EXECUTED (2026-09-01, feat/web-port-auth-enforcement)

All steps S1–S7 completed. Commits on feat/web-port-auth-enforcement (branched from feat/swarm-memory-rag @ 4cd5ef9 — NOT main, deliberate deviation: the swarm-memory workflow/drone-swarm-session code the plan modifies exists only on that unmerged chain):
- 938ead7 fix(coordinator): protect /api routes on the web port (auth prefix gap) — '/api' added to PROTECTED_PREFIXES; isLocalRequest bypass untouched; 5 new unit tests (unit-level mock req/reply pattern, matching the existing file, not app-inject as the plan assumed)
- f4e5e7d feat(drone-swarm): --web-token flag + DRONE_COORDINATOR_WEB_TOKEN env (flag wins, Bearer only when set, beacon unaffected); SwarmClient 4th ctor param; HELP updated; 5 new tests — NOTE: token assertions use `wiki read` (pass-through response), NOT `session list` (CLI rebuilds the output object and drops unknown fields); fixture echoes the Authorization header
- 54e6d19 feat(bootstrap): default URL → http://localhost:8080; probe keeps drone-swarm session list but adds `sh -c 'command -v drone-swarm'` presence check + classifyProbe/describeProbeFailure (exit code + stderr surfaced in discovery prompt and hard-stop message); optional 5th 'webToken' discovery question; env file written 0600 ONLY when token supplied (single-quote-escaped); hook/catchup scripts source ~/.drone-swarm-memory/env via IF-BLOCK (plan's `[ -f ] && .` form dies under set -e when absent — corrected during execution); smoke calls thread --web-token; 4 new tests
- 49b401d fix(ui): login.tsx probes GET /api/personas (401 → gate; ok → setToken; other/network → permissive fallback preserved); new 5-test login.test.tsx
- 221c82d style: prettier pass
- Vault commit acbd644 on main: ADR 182 + decisions/index (181→182, both tables) + root index latest pointer + concepts/coordinator-web-auth (/api enforcement + login probe) + modules/drone-swarm (web-token section) + modules/drone-agent-plugins (bootstrap update row)

## Validation (all green)
- pnpm -r run build ✅; pnpm typecheck ✅; pnpm lint ✅; root pnpm test = 192 files / 2664 tests (was 2650; +14 = exactly the 5+5+4 new tests... plus login suite counted in UI config? No — UI suite is separate; the +14 = 5 auth + 5 token + 4 workflow; the 5 login tests live in the UI package config, verified separately: NODE_ENV=test npx vitest run → 11 passed incl. use-auth)
- LSP: zero error diagnostics workspace-wide
- UI suite caveat: NODE_ENV=production leaked from operator shell breaks React testing-library ("React.act is not a function") — run UI tests with NODE_ENV=test (insight logged)
- Security invariant unit-pinned; live manual smoke (remote 401/Bearer-200) left to operator per plan's optional note
- Deferred items untouched: restart unit-name fix + --help HTTPS drift (→ plan-workflow-system-improvements fold-ins), phase-2 backlog

## Grilled decisions (archived, unchanged)
- Q1: '/api' into PROTECTED_PREFIXES; isLocalRequest (loopback/interfaces/Tailscale) untouched
- Q2: --web-token + DRONE_COORDINATOR_WEB_TOKEN, flag wins, Bearer only when set, beacon no-op
- Q3: default URL 8080; probe stays drone-swarm session list; binary check + stderr surfacing
- Q4: env-file sourcing (0600, only when token supplied); scripts stay 0755
- Q5: always-ask optional token question, empty default
- Q6: login probes protected /api/personas; permissive fallback for non-401/network
- Q7: restart-name + --help drift deferred to workflow rework

## Original problem statement (for posterity)
The coordinator's web port *appeared* token-protected but was not: PROTECTED_PREFIXES listed root-level prefixes while all API routes live under /api. Live-confirmed 2026-09-01 (bare curl → full beacon registry). UI and gateway were already compliant; drone-swarm/scripts/probe sent nothing.