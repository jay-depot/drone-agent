---
tags: [decision, coordinator, web-auth, security, drone-swarm, bootstrap]
related: [decisions/180-swarm-memory-bootstrap-workflow.md, concepts/coordinator-web-auth.md, concepts/memory-pipeline.md, modules/drone-swarm.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md]
---

# 182 — Web-port `/api` auth enforcement + pipeline token path

**Date**: 2026-09-01 · **Status**: Accepted · **Branch**: `feat/web-port-auth-enforcement` (off `feat/swarm-memory-rag` @ `4cd5ef9`)

## Context

The coordinator's web port *appeared* token-protected but was not. `PROTECTED_PREFIXES` (drone-coordinator/src/web-auth.ts) lists root-level prefixes (`/sessions`, `/wiki`, …) — but every API route moved under `/api` (routes/index.ts mounts with `prefix: '/api'`), and `isProtectedPath` receives the full `/api/…` URL. Nothing matched; the Bearer check never ran. Live-confirmed 2026-09-01: a bare `curl http://localhost:4300/api/beacons` returned the full beacon registry on the operator's host. The login page compounded the theater: it "validated" typed tokens against `/health` — auth-exempt, answers 200 to *any* token — so garbage tokens passed the gate and bounced later on first real API call.

The gap was found while debugging `bootstrap__swarm-memory`: its reachability probe shells out to `drone-swarm`, which sends no auth header — and the primary port (3456) is unreachable to it regardless (HTTPS + self-signed + mTLS client-cert pinning, no loopback exemption). Enforcing the token on the web port without giving the pipeline a token path would strand the ingest hook and catch-up job for any non-loopback coordinator.

**Consumer map** (enumerated before the change): coordinator-ui (all calls via `useAuthenticatedFetch`, Bearer already attached) ✅ compliant; drone-gateway `CoordinatorClient` (Bearer on every request) ✅ compliant; drone-swarm CLI + bootstrap-generated scripts ❌ sent nothing; bootstrap probe ❌ same. Beacon/primary-port/mTLS untouched by design.

## Decision

Six grilled decisions (Q1–Q6), minimal-scope per user direction:

**Q1 — Gap close, bypass untouched.** Add `/api` to `PROTECTED_PREFIXES`. `isLocalRequest` (loopback, the machine's own interfaces, Tailscale 100.64.0.0/10) stays the local bypass — remote callers must now present the Bearer token; local callers (curl, hook, workflow on the coordinator host) never need one.

**Q2 — drone-swarm token source: flag + env.** `--web-token <t>` flag and `DRONE_COORDINATOR_WEB_TOKEN` env (flag wins); `Authorization: Bearer` sent only when a token is set; the beacon target ignores both (no token concept there). Header format matches what the UI and gateway already send.

**Q3 — Bootstrap probe: keep the binary, tell the truth.** Default URL becomes `http://localhost:8080` (the web port; 3456 is TLS+mTLS and unreachable to drone-swarm in every URL form). The probe *stays* `drone-swarm session list` rather than switching to `GET /health` — it validates the exact binary + route dialect + token path the pipeline will use, and catches the missing-binary failure class at the front door. Failure reporting gains a binary-presence check (`sh -c 'command -v drone-swarm'`) and surfaces exit code + stderr in both the discovery prompt and the hard-stop message (previously every failure — ENOENT, connection-refused, 401 — read as "not reachable"; a missing `drone-swarm` link cost the operator a debugging session).

**Q4 — Env-file, not baked secrets.** Generated hook/catch-up scripts source `~/.drone-swarm-memory/env` via an `if [ -f … ]` block (an `[ … ] && . …` chain would exit the script under `set -e` when the file is absent). The bootstrap writes that env file (`export DRONE_COORDINATOR_WEB_TOKEN='<token>'`, single-quote-escaped, chmod 0600) **only when a token was supplied**; scripts stay 0755 and secret-free; the default loopback topology writes nothing.

**Q5 — Always-ask, optional token question.** A fifth discovery question ("Leave empty when the coordinator is local"), empty default. When set: probe and smoke-test calls pass `--web-token`; env file written per Q4. Zero prompts added for the common case is rejected as brittle (it would parse the stderr of whatever drone-swarm version is installed).

**Q6 — Login validates against a protected endpoint.** `login.tsx` probes `GET /api/personas` with the Bearer header: 401 → gate error; ok → setToken; other statuses (429/5xx) and network errors keep the permissive fallback so offline/first-run UX survives.

**Deferred (Q7)** to the upcoming workflow-rework effort: restart unit-name mismatch (`systemctl restart coordinator` vs probed `drone-coordinator`) and the coordinator `--help` HTTPS-default drift line.

## Consequences

- Remote access to any `/api/*` route on the web port now requires the web token; loopback and Tailscale peers are unchanged. The web UI login is meaningful again end-to-end.
- Consumers that send nothing must migrate to the token path — drone-swarm and the generated scripts have it built in; ad-hoc remote curls need `-H "Authorization: Bearer $(drone-coordinator --show-web-token)"`.
- The probe failure message names its real cause: missing binary vs dead server vs auth rejection.
- Cron note: the catch-up job runs with a minimal PATH (`/usr/bin:/bin`) — `drone-swarm` must be linked somewhere cron can see (e.g. `/usr/local/bin`), token or not.
- En-route test discoveries: the coordinator auth tests are unit-level (mock req/reply), not app-inject as first assumed; drone-swarm's `session list` output is rebuilt server-side by the CLI (echo-field assertions must use pass-through commands like `wiki read`); a stray exported `NODE_ENV=production` makes React testing-library fail (`React.act is not a function`) because act exists only in dev builds — run UI suites with `NODE_ENV=test`.
- New tests: 5 coordinator auth cases, 5 drone-swarm token cases (fixture echoes the Authorization header), 4 workflow cases (env-file perms/content, token threading, binary-missing + stderr surfacing), 5 login page cases. Fast suite 192 files / 2664 tests green.

## Related

- [180-swarm-memory-bootstrap-workflow](180-swarm-memory-bootstrap-workflow.md) · coordinator-web-auth · memory-pipeline
- [drone-swarm](../../drone-swarm/) · [drone-coordinator](../../drone-coordinator/) · [drone-coordinator-ui](../../drone-coordinator-ui/)