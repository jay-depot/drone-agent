---
key: coordinator-probe-auth-gap
tags:
  - swarm
  - coordinator
  - bootstrap
  - auth
  - resolved
created: 2026-09-01T20:48:07.995Z
updated: 2026-09-01T21:50:54.708Z
---

RESOLVED (2026-09-01): Both the primary-port unreachability and the web-port /api token theater documented in the 2026-09-01 findings are now FIXED on feat/web-port-auth-enforcement (see project memory plan-web-port-auth-enforcement for the full commit list; ADR 182 in the vault).

What shipped:
- /api added to PROTECTED_PREFIXES (web port now actually enforces the Bearer token for non-local callers; loopback/Tailscale bypass intact).
- drone-swarm --web-token flag + DRONE_COORDINATOR_WEB_TOKEN env (flag wins; Bearer only when set; beacon target unaffected).
- bootstrap__swarm-memory: default URL http://localhost:8080 (web port); probe = command -v drone-swarm presence check + drone-swarm session list with exit/stderr surfaced in the failure message; optional token question; env file ~/.drone-swarm-memory/env (0600) sourced by hook+catch-up scripts, written only when a token was supplied.
- UI login validates against GET /api/personas (401 gates; permissive fallback for network/other statuses).

STILL OPEN (assigned to the workflow-rework effort, plan-workflow-system-improvements): restart unit-name mismatch (detectLaunchMode probes drone-coordinator but restartServer runs `systemctl restart coordinator` / `docker restart coordinator`) and coordinator --help HTTPS-default drift (help says COORDINATOR_HTTPS env controls the default; code hardcodes useHttps:true). Operator host context for the restart fix: coordinator runs natively on ambiorix, web port 4300 (custom).