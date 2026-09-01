---
key: plan-web-port-auth-enforcement
tags:
  - plan
  - ready
  - coordinator
  - web-auth
  - drone-swarm
  - bootstrap
  - security
created: 2026-09-01T21:16:27.231Z
updated: 2026-09-01T21:16:27.231Z
---

# Plan: Close the coordinator web-port /api auth gap + give the pipeline a token path

## Summary

The coordinator's web port _appears_ token-protected but is not: `PROTECTED_PREFIXES` (drone-coordinator/src/web-auth.ts:9-25) lists root-level prefixes ('/sessions','/wiki',…) while all API routes live under `/api` (routes/index.ts prefix:'/api'). `isProtectedPath` receives the full '/api/…' URL, matches nothing, and the Bearer check never runs. Live-confirmed 2026-09-01 (bare curl → full beacon registry). Fix = add '/api' to the prefix list (Q1), shipped together with token support for the consumers that send nothing today (drone-swarm CLI + bootstrap-generated scripts + workflow probe) so no consumer strands. UI (useAuthenticatedFetch) and gateway (CoordinatorClient Bearer) are already compliant — verified. Beacon/primary-port/mTLS untouched.

## Grilled decisions (2026-09-01)

- Q1: Minimal gap-close. Add '/api' to PROTECTED_PREFIXES. `isLocalRequest` (loopback, own interfaces, Tailscale 100.64/10) stays untouched as local bypass. Remote callers must send Bearer.
- Q2: drone-swarm gains `--web-token <t>` flag + `DRONE_COORDINATOR_WEB_TOKEN` env (flag wins). `Authorization: Bearer` header sent only when token set. Beacon target: no-op (no token concept).
- Q3: Bootstrap workflow — DEFAULT_COORDINATOR_URL → `http://localhost:8080`. Probe STAYS `drone-swarm session list` (validates the exact binary+route+token path the pipeline uses, catches the missing-binary failure class at the front door). Failure message gains: binary-presence check + stderr/exit code from the probe result (current message hides ENOENT vs refused vs 401).
- Q4: Generated hook/catch-up scripts gain one sourcing line: `[ -f "$HOME/.drone-swarm-memory/env" ] && . "$HOME/.drone-swarm-memory/env"`. Bootstrap writes that env file ONLY when a token was supplied: `export DRONE_COORDINATOR_WEB_TOKEN='<token>'` (shell-quote or restrict charset; token is generated hex today), chmod 0600 via existing atomicWrite. Scripts stay 0755/secret-free. No token → no file → no behavior change (default loopback topology).
- Q5: Discovery asks optional 5th question "web token (empty when coordinator is local)". Non-empty → probe/smoke calls add `--web-token`, env file written per Q4. Empty → exactly today's flow.
- Q6: login.tsx validates the typed token against a cheap PROTECTED endpoint (`GET /api/personas` with Bearer) instead of auth-exempt `/health` (which 200s any token). 401 → gate error; ok → setToken; network error → keep permissive fallback (store + let app 401-handle) so offline/first-run UX survives. Non-401 non-ok (429/5xx) → keep permissive fallback.
- Q7: Restart unit-name mismatch (`systemctl restart coordinator` vs probed `drone-coordinator`) and coordinator `--help` HTTPS-default drift are DEFERRED to the user's upcoming workflow-rework effort (recorded in project memory coordinator-probe-auth-gap).

## Steps (branch: feat/web-port-auth-enforcement off current main; deps: S1→S2→S3, S4 independent, S5 last)

- S1 (coder, coordinator): In drone-coordinator/src/web-auth.ts add '/api' to PROTECTED_PREFIXES (array order irrelevant; keep grouping). Tests in drone-coordinator/test/auth.test.ts (exists; uses app-helper buildApp): new cases — (1) request from non-local IP (mock: app.inject with remoteAddress or inject's `remoteAddress` option) to GET /api/sessions without token → 401; (2) same with `Authorization: Bearer <token>` → 200; (3) loopback without token → 200; (4) non-/api path (e.g. '/assets/x') remote without token → 200. Follow existing patterns in that file (it already builds apps with getToken).

- S2 (coder, drone-swarm): client.ts — SwarmClient ctor gains optional 4th param `webToken?: string`; request() adds `Authorization: Bearer ${webToken}` only when webToken non-empty (header merge with existing Content-Type logic). index.ts main(): resolve token = args.flags['web-token'] || (target==='coordinator' ? process.env.DRONE_COORDINATOR_WEB_TOKEN : undefined); pass into SwarmClient. HELP text gains the flag + env doc lines. Tests in drone-swarm/test/cli.test.ts (fetchImpl-injectable main): (1) --web-token flag → Authorization header present; (2) env var present → header present; (3) both → flag value wins (assert exact header value); (4) neither → no Authorization header; (5) --beacon target + env set → header ABSENT.

- S3 (coder, bootstrap workflow): drone-agent/src/plugins/bootstrap/swarm-memory.ts + swarm-memory-scripts.ts —
  (a) DEFAULT_COORDINATOR_URL → 'http://localhost:8080'.
  (b) SwarmMemorySettings gains `webToken: string` ('' default). Discovery gains 5th question (id 'webToken', freeform, placeholder '(empty if local)', default '') right after coordinatorUrl.
  (c) probeCoordinator: before first call run `['sh','-c','command -v drone-swarm >/dev/null 2>&1']` (runner spawns without shell, so 'command -v' must go through sh; 'which' is not guaranteed on Arch). If missing → return structured failure {reason:'binary-missing'}. When settings.webToken non-empty, append '--web-token', settings.webToken to the drone-swarm args. New helper describeProbeFailure(result) → human hint: binary-missing | `exit ${code}: ${stderr.trim() || stdout.trim().slice(0,200)}`. Both the discover() prompt text (REACHABLE/NOT) and run()'s hard-stop JSON message include the hint.
  (d) buildHookScript + buildCatchupScript: after `set -euo pipefail` add the env-source line from Q4 (both scripts; comment notes bootstrap wrote it). Script content changes are pure-string → update existing builder tests.
  (e) In run(): after hook/catchup writes, if settings.webToken non-empty → atomicWrite(path.join(home, MEMORY_DIR, 'env'), `export DRONE_COORDINATOR_WEB_TOKEN='${escapedToken}'\n`, 0o600) (escapedToken: allow [A-Za-z0-9._-] or single-quote-escape); add StepReport entry 'env-file'. Empty token → no write, no report entry.
  (f) smokeTest runner calls also get --web-token when set.
  Tests: drone-agent/test/plugins/bootstrap/swarm-memory.test.ts — update discovery mock answers (+webToken), default-URL assertions (8080), new cases: token set → env file written with 0600 + probe args include --web-token; token empty → no env file; binary-missing runner → failure message contains 'drone-swarm' + 'not found'-class hint; stderr surfacing (fake runner returns code 7 + stderr) → message includes stderr.

- S4 (coder, UI): drone-coordinator-ui/src/pages/login.tsx — change validation fetch '/health' → '/api/personas' (keep Bearer header; update the two comments). Fallback semantics: 401 → error; ok → setToken; other status or network error → permissive fallback (unchanged behavior). Update/add page test following existing UI test patterns (use-auth.test.tsx style; there may be no login.test.tsx yet — add one asserting 401 shows error + no setToken, ok calls setToken).

- S5 (validation): `pnpm -r run build` (drone-swarm + drone-coordinator-ui dist must rebuild BEFORE dependent checks), `pnpm typecheck`, `pnpm lint` (root), root `pnpm test` fast suite (NOTE per insight: `pnpm -r run test` fails pre-existing at drone-core "No test files found" — root pnpm test is the real gate). LSP diagnostics clean on all touched files. Manual smoke (optional, documented in ADR): on a remote box `curl http://host:8080/api/sessions` → 401; with `-H "Authorization: Bearer $(drone-coordinator --show-web-token)"` → 200; loopback curl still 200 without token.

- S6 (docs): ADR 182 in /home/unleet/Obsidian/drone-agent-project/decisions/182-web-port-api-auth-enforcement.md (Context: token theater discovery + live evidence + consumer map; Decision: Q1-Q6; Consequences: remote callers need token, cron PATH note for drone-swarm). Update vault: decisions/index.md (+1 count, both tables), concepts/coordinator-web-auth.md (real enforcement + login probe), modules/drone-swarm.md (flag/env), modules/drone-agent-plugins.md (bootstrap probe changes). Repo docs: none required beyond drone-swarm HELP (done in S2).

- S7 (final): log insights (planner persona: probe-that-shells-out must surface stderr; auth-prefix lists must be generated/derived from route prefixes — this is the 2nd prefix-drift bug class in the codebase). Update project memories (coordinator-probe-auth-gap → mark fix planned). Commit .drone-agent + vault changes per policy: only on the feature branch, never main.

## Validation criteria

- All S1–S4 tests pass; no existing tests regressed (root pnpm test fast suite green, 192+ files).
- LSP: zero diagnostics on touched files (web-auth.ts, client.ts, index.ts, swarm-memory.ts, swarm-memory-scripts.ts, login.tsx + tests).
- pnpm -r run build, pnpm typecheck, pnpm lint all pass.
- Security invariant: non-loopback request to any /api/* route without Bearer → 401; with valid token → 200; loopback unchanged.
- Bootstrap workflow end-to-end (native, loopback): zero tokens needed, URL default 8080, probe failures name the real cause.
- No changes to: beacon, primary port/mTLS, gateway, UI internals beyond login.tsx, session pipeline semantics.

## Explicitly deferred

- Restart unit-name fix + --help HTTPS drift → user's workflow-rework effort.
- swarm.memory read-side bootstrap + stale-session UI + librarian migration → swarm-memory-phase-2-backlog (project memory).
